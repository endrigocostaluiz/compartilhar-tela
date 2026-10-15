@echo off
chcp 65001 >nul
title Compartilhar Tela - Assistente de audio
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); $i=$t.IndexOf('#<'+'PS>'); Invoke-Expression $t.Substring($i)"
echo.
echo O assistente foi encerrado. Pode fechar esta janela.
pause >nul
exit /b
#<PS>
# ============================================================================
#  Compartilhar Tela — Assistente de áudio (Windows 10 2004+ / Windows 11)
#
#  O que faz: deixa você escolher QUAIS aplicativos entram no áudio da transmissão
#  (ex.: só o jogo, ou tudo menos o Discord). O navegador sozinho não consegue isso.
#
#  Como funciona: usa a captura de áudio por aplicativo do próprio Windows (a mesma
#  do OBS) e entrega o som à página, por uma conexão LOCAL (127.0.0.1). Nada sai do
#  seu computador por aqui, e só a página do Compartilhar Tela consegue se conectar.
#
#  Este arquivo é texto puro: pode abrir no Bloco de Notas e conferir tudo.
#  Não instala nada. Para parar, feche esta janela.
# ============================================================================
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$codigo = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class Assistente
{
    // ---- Configuração ----
    public const int Porta = 17653;
    // Só estas páginas podem se conectar (o navegador envia o cabeçalho Origin e o site não consegue falsificá-lo).
    static readonly string[] OrigensPermitidas = {
        "https://endrigocostaluiz.github.io",
        "http://localhost:8080",
        "http://127.0.0.1:8080"
    };
    public const int Rate = 48000, Canais = 2;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    // =====================================================================
    //  Captura de áudio por aplicativo (WASAPI process loopback)
    // =====================================================================
    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler { void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op); }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defPeriod, out long minPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devPos, out ulong qpcPos);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [ClassInterface(ClassInterfaceType.None)]
    class Handler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public ManualResetEvent Done = new ManualResetEvent(false);
        public int Hr;
        public object Iface;
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op)
        {
            int hr; object o;
            op.GetActivateResult(out hr, out o);
            Hr = hr; Iface = o; Done.Set();
        }
    }

    // Buffer circular simples (1 s) com descarte do mais antigo.
    class Anel
    {
        byte[] d = new byte[Rate * Canais * 2];
        int ini = 0, qtd = 0;
        public void Escrever(byte[] b, int n)
        {
            lock (this)
            {
                if (n >= d.Length) { Array.Copy(b, n - d.Length, d, 0, d.Length); ini = 0; qtd = d.Length; return; }
                int livre = d.Length - qtd;
                if (n > livre) { int cortar = n - livre; ini = (ini + cortar) % d.Length; qtd -= cortar; }
                int fim = (ini + qtd) % d.Length;
                int a = Math.Min(n, d.Length - fim);
                Array.Copy(b, 0, d, fim, a);
                if (a < n) Array.Copy(b, a, d, 0, n - a);
                qtd += n;
            }
        }
        public int Ler(byte[] dst, int n)
        {
            lock (this)
            {
                int k = Math.Min(n, qtd);
                int a = Math.Min(k, d.Length - ini);
                Array.Copy(d, ini, dst, 0, a);
                if (a < k) Array.Copy(d, 0, dst, a, k - a);
                ini = (ini + k) % d.Length; qtd -= k;
                return k;
            }
        }
        public int Disponivel { get { lock (this) return qtd; } }
        public void Descartar(int manter) { lock (this) { if (qtd > manter) { int c = qtd - manter; ini = (ini + c) % d.Length; qtd = manter; } } }
    }

    class Fonte
    {
        public uint Pid; public bool Incluir;
        public Anel Fila = new Anel();
        IAudioClient client; IAudioCaptureClient cap; Thread th; volatile bool run;
        ManualResetEvent evt = new ManualResetEvent(false);

        public static Fonte Iniciar(uint pid, bool incluir)
        {
            var f = new Fonte { Pid = pid, Incluir = incluir };
            Exception erro = null;
            var pronto = new ManualResetEvent(false);
            f.th = new Thread(() =>
            {
                try { f.Abrir(); }
                catch (Exception e) { erro = e; pronto.Set(); return; }
                pronto.Set();
                f.Laco();
            });
            f.th.SetApartmentState(ApartmentState.MTA);
            f.th.IsBackground = true;
            f.th.Start();
            pronto.WaitOne();
            if (erro != null) throw erro;
            return f;
        }

        void Abrir()
        {
            IntPtr prm = Marshal.AllocHGlobal(12);
            Marshal.WriteInt32(prm, 0, 1);                  // PROCESS_LOOPBACK
            Marshal.WriteInt32(prm, 4, (int)Pid);
            Marshal.WriteInt32(prm, 8, Incluir ? 0 : 1);    // 0 = só este app, 1 = tudo MENOS este app
            IntPtr pv = Marshal.AllocHGlobal(24);
            for (int i = 0; i < 24; i++) Marshal.WriteByte(pv, i, 0);
            Marshal.WriteInt16(pv, 0, 65);                  // VT_BLOB
            Marshal.WriteInt32(pv, 8, 12);
            Marshal.WriteIntPtr(pv, 8 + IntPtr.Size, prm);

            var h = new Handler();
            IActivateAudioInterfaceAsyncOperation op;
            ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IAudioClient).GUID, pv, h, out op);
            if (!h.Done.WaitOne(8000)) throw new Exception("tempo esgotado ao ativar a captura");
            if (h.Hr != 0) throw new Exception("o Windows recusou a captura (0x" + h.Hr.ToString("X8") + ")");
            client = (IAudioClient)h.Iface;

            IntPtr fmt = Marshal.AllocHGlobal(18);
            Marshal.WriteInt16(fmt, 0, 1);
            Marshal.WriteInt16(fmt, 2, (short)Canais);
            Marshal.WriteInt32(fmt, 4, Rate);
            Marshal.WriteInt32(fmt, 8, Rate * Canais * 2);
            Marshal.WriteInt16(fmt, 12, (short)(Canais * 2));
            Marshal.WriteInt16(fmt, 14, 16);
            Marshal.WriteInt16(fmt, 16, 0);
            int hr = client.Initialize(0, 0x00020000 | 0x00040000 | unchecked((int)0x80000000) | 0x08000000, 200000, 0, fmt, IntPtr.Zero);
            if (hr != 0) throw new Exception("Initialize 0x" + hr.ToString("X8"));
            client.SetEventHandle(evt.SafeWaitHandle.DangerousGetHandle());
            object o;
            hr = client.GetService(typeof(IAudioCaptureClient).GUID, out o);
            if (hr != 0) throw new Exception("GetService 0x" + hr.ToString("X8"));
            cap = (IAudioCaptureClient)o;
            hr = client.Start();
            if (hr != 0) throw new Exception("Start 0x" + hr.ToString("X8"));
            run = true;
        }

        void Laco()
        {
            byte[] buf = new byte[65536];
            while (run)
            {
                evt.WaitOne(100);
                uint n;
                while (run && cap.GetNextPacketSize(out n) == 0 && n > 0)
                {
                    IntPtr p; uint frames, flags; ulong a, b;
                    if (cap.GetBuffer(out p, out frames, out flags, out a, out b) != 0) break;
                    int len = (int)frames * Canais * 2;
                    if (len > buf.Length) buf = new byte[len];
                    if ((flags & 2) != 0) Array.Clear(buf, 0, len); else Marshal.Copy(p, buf, 0, len);
                    cap.ReleaseBuffer(frames);
                    Fila.Escrever(buf, len);
                }
            }
        }

        public void Parar() { run = false; try { client.Stop(); } catch { } }
    }

    // =====================================================================
    //  Lista de aplicativos que têm áudio (sessões de áudio do Windows)
    // =====================================================================
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr c);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr c);
    }
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint n);
        [PreserveSig] int Item(uint i, out IMMDevice d);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr props);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }
    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr g, uint flags, out IntPtr ctl);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr g, uint flags, out IntPtr vol);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
        [PreserveSig] int RegisterSessionNotification(IntPtr n);
        [PreserveSig] int UnregisterSessionNotification(IntPtr n);
        [PreserveSig] int RegisterDuckNotification(IntPtr id, IntPtr n);
        [PreserveSig] int UnregisterDuckNotification(IntPtr n);
    }
    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int n);
        [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s);
    }
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(IntPtr p);
        [PreserveSig] int SetDisplayName(IntPtr a, IntPtr b);
        [PreserveSig] int GetIconPath(IntPtr p);
        [PreserveSig] int SetIconPath(IntPtr a, IntPtr b);
        [PreserveSig] int GetGroupingParam(IntPtr p);
        [PreserveSig] int SetGroupingParam(IntPtr a, IntPtr b);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
        [PreserveSig] int GetSessionIdentifier(IntPtr p);
        [PreserveSig] int GetSessionInstanceIdentifier(IntPtr p);
        [PreserveSig] int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference(int optOut);
    }
    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float peak);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    class Proc { public uint Ppid; public string Exe; }

    static Dictionary<uint, Proc> Processos()
    {
        var m = new Dictionary<uint, Proc>();
        IntPtr s = CreateToolhelp32Snapshot(2, 0);
        if (s == IntPtr.Zero || s == (IntPtr)(-1)) return m;
        var e = new PROCESSENTRY32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        if (Process32FirstW(s, ref e))
            do { m[e.th32ProcessID] = new Proc { Ppid = e.th32ParentProcessID, Exe = (e.szExeFile ?? "").ToLowerInvariant() }; }
            while (Process32NextW(s, ref e));
        CloseHandle(s);
        return m;
    }

    // Sobe até o processo "raiz" do mesmo programa (ex.: o Discord.exe principal, e não o subprocesso de áudio):
    // incluir/excluir a raiz vale para o programa inteiro.
    static uint Raiz(uint pid, Dictionary<uint, Proc> mapa)
    {
        uint atual = pid; int voltas = 0;
        while (voltas++ < 12)
        {
            Proc p, pai;
            if (!mapa.TryGetValue(atual, out p)) break;
            if (!mapa.TryGetValue(p.Ppid, out pai) || pai.Exe != p.Exe) break;
            atual = p.Ppid;
        }
        return atual;
    }

    static string NomeAmigavel(uint pid, out string exe)
    {
        exe = "";
        try
        {
            using (var pr = Process.GetProcessById((int)pid))
            {
                exe = pr.ProcessName;
                string nome = exe;
                try
                {
                    var d = pr.MainModule.FileVersionInfo.FileDescription;
                    if (!string.IsNullOrWhiteSpace(d)) nome = d.Trim();
                }
                catch { }
                return nome;
            }
        }
        catch { return "Processo " + pid; }
    }

    static List<Dictionary<string, object>> ListarApps()
    {
        var picos = new Dictionary<uint, double>(); var ativos = new Dictionary<uint, bool>();
        var mapa = Processos();
        IMMDeviceEnumerator en = null; IMMDeviceCollection col = null;
        try
        {
            en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            if (en.EnumAudioEndpoints(0, 1, out col) != 0) return new List<Dictionary<string, object>>();
            uint nd; col.GetCount(out nd);
            for (uint i = 0; i < nd; i++)
            {
                IMMDevice dev; object o = null; IAudioSessionManager2 mgr = null; IAudioSessionEnumerator se = null;
                if (col.Item(i, out dev) != 0) continue;
                try
                {
                    Guid iid = typeof(IAudioSessionManager2).GUID;
                    if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
                    mgr = (IAudioSessionManager2)o;
                    if (mgr.GetSessionEnumerator(out se) != 0) continue;
                    int ns; se.GetCount(out ns);
                    for (int k = 0; k < ns; k++)
                    {
                        IAudioSessionControl2 sc;
                        if (se.GetSession(k, out sc) != 0) continue;
                        try
                        {
                            if (sc.IsSystemSoundsSession() == 0) continue;
                            uint pid; sc.GetProcessId(out pid);
                            if (pid == 0) continue;
                            uint raiz = Raiz(pid, mapa);
                            int st; sc.GetState(out st);
                            float pk = 0; try { ((IAudioMeterInformation)sc).GetPeakValue(out pk); } catch { }
                            double antes; picos.TryGetValue(raiz, out antes); picos[raiz] = Math.Max(antes, pk);
                            bool at; ativos.TryGetValue(raiz, out at); ativos[raiz] = at || st == 1;
                        }
                        finally { Marshal.ReleaseComObject(sc); }
                    }
                }
                finally
                {
                    if (se != null) Marshal.ReleaseComObject(se);
                    if (mgr != null) Marshal.ReleaseComObject(mgr);
                    Marshal.ReleaseComObject(dev);
                }
            }
        }
        catch { }
        finally
        {
            if (col != null) Marshal.ReleaseComObject(col);
            if (en != null) Marshal.ReleaseComObject(en);
        }

        var lista = new List<Dictionary<string, object>>();
        foreach (var par in picos)
        {
            string exe; string nome = NomeAmigavel(par.Key, out exe);
            if (string.Equals(exe, "audiodg", StringComparison.OrdinalIgnoreCase)) continue;
            var d = new Dictionary<string, object>();
            d["pid"] = par.Key; d["nome"] = nome; d["exe"] = exe;
            d["nivel"] = Math.Round(par.Value, 3); d["tocando"] = ativos[par.Key] && par.Value > 0.001;
            lista.Add(d);
        }
        lista.Sort((a, b) => string.Compare((string)a["nome"], (string)b["nome"], StringComparison.CurrentCultureIgnoreCase));
        return lista;
    }

    // =====================================================================
    //  Servidor WebSocket local (somente 127.0.0.1)
    // =====================================================================
    class Cliente
    {
        public TcpClient Tcp; public NetworkStream Ns; public volatile bool Vivo = true;
        public readonly object Escrita = new object();

        public void Enviar(int opcode, byte[] dados, int len)
        {
            lock (Escrita)
            {
                try
                {
                    var cab = new List<byte>(10);
                    cab.Add((byte)(0x80 | opcode));
                    if (len < 126) cab.Add((byte)len);
                    else if (len < 65536) { cab.Add(126); cab.Add((byte)(len >> 8)); cab.Add((byte)len); }
                    else { cab.Add(127); for (int i = 7; i >= 0; i--) cab.Add((byte)(((long)len) >> (8 * i))); }
                    Ns.Write(cab.ToArray(), 0, cab.Count);
                    Ns.Write(dados, 0, len);
                }
                catch { Vivo = false; }
            }
        }
        public void Texto(object o) { var b = Encoding.UTF8.GetBytes(Json.Serialize(o)); Enviar(1, b, b.Length); }
    }

    static Cliente atual;
    static readonly object trava = new object();
    static Dictionary<uint, Fonte> fontes = new Dictionary<uint, Fonte>();
    static string modoAtual = ""; static List<string> erros = new List<string>();

    static void Log(string s) { Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + s); }

    static void PararFontes()
    {
        lock (trava)
        {
            foreach (var f in fontes.Values) f.Parar();
            fontes.Clear(); modoAtual = ""; erros.Clear();
        }
    }

    // Aplica a seleção do usuário: "incluir" (só estes apps, pode ser vários) ou "excluir" (tudo menos 1 app).
    static void Escolher(string modo, List<uint> pids)
    {
        lock (trava)
        {
            bool incluir = modo != "excluir";
            if (modo != modoAtual) { foreach (var f in fontes.Values) f.Parar(); fontes.Clear(); }
            modoAtual = modo; erros.Clear();
            if (!incluir && pids.Count > 1) pids = new List<uint> { pids[0] }; // o Windows só exclui uma árvore por captura
            foreach (var pid in new List<uint>(fontes.Keys))
                if (!pids.Contains(pid)) { fontes[pid].Parar(); fontes.Remove(pid); }
            foreach (var pid in pids)
            {
                if (fontes.ContainsKey(pid)) continue;
                try { fontes[pid] = Fonte.Iniciar(pid, incluir); Log("Capturando " + (incluir ? "SÓ" : "TUDO MENOS") + " o processo " + pid); }
                catch (Exception e) { erros.Add("processo " + pid + ": " + e.Message); Log("Erro: " + e.Message); }
            }
        }
    }

    static void Misturador(Cliente c)
    {
        // Entrega 10 ms de áudio por vez, em tempo real: soma as fontes (apps marcados) e envia à página.
        var sw = Stopwatch.StartNew();
        long enviados = 0; const int frames = 480; int bytes = frames * Canais * 2;
        byte[] tmp = new byte[bytes], saida = new byte[bytes]; int[] soma = new int[frames * Canais];
        while (c.Vivo)
        {
            double devidos = sw.Elapsed.TotalSeconds * Rate - enviados;
            if (devidos < frames) { Thread.Sleep(2); continue; }
            enviados += frames;
            List<Fonte> lista;
            lock (trava) lista = new List<Fonte>(fontes.Values);
            if (lista.Count == 0) continue;
            Array.Clear(soma, 0, soma.Length);
            foreach (var f in lista)
            {
                if (f.Fila.Disponivel > bytes * 8) f.Fila.Descartar(bytes * 3); // atraso demais: pula para manter o som "ao vivo"
                int k = f.Fila.Ler(tmp, bytes);
                for (int i = 0; i + 1 < k; i += 2) soma[i / 2] += BitConverter.ToInt16(tmp, i);
            }
            for (int i = 0; i < soma.Length; i++)
            {
                int v = soma[i]; if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
                saida[i * 2] = (byte)(v & 0xFF); saida[i * 2 + 1] = (byte)((v >> 8) & 0xFF);
            }
            c.Enviar(2, saida, bytes);
        }
    }

    static void Tratar(Cliente c)
    {
        var ns = c.Ns;
        // --- handshake HTTP -> WebSocket ---
        var sb = new StringBuilder(); var b1 = new byte[1];
        while (!sb.ToString().EndsWith("\r\n\r\n"))
        {
            if (ns.Read(b1, 0, 1) <= 0) return;
            sb.Append((char)b1[0]); if (sb.Length > 8192) return;
        }
        string req = sb.ToString(); string chave = null, origem = null;
        foreach (var linha in req.Split(new[] { "\r\n" }, StringSplitOptions.RemoveEmptyEntries))
        {
            int p = linha.IndexOf(':'); if (p < 0) continue;
            string k = linha.Substring(0, p).Trim().ToLowerInvariant(), v = linha.Substring(p + 1).Trim();
            if (k == "sec-websocket-key") chave = v; else if (k == "origin") origem = v;
        }
        bool permitido = origem != null && Array.IndexOf(OrigensPermitidas, origem) >= 0;
        if (chave == null || !permitido)
        {
            Log("Conexão recusada (origem: " + (origem ?? "nenhuma") + ")");
            var r = Encoding.ASCII.GetBytes("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            ns.Write(r, 0, r.Length); return;
        }
        string aceita = Convert.ToBase64String(SHA1.Create().ComputeHash(Encoding.ASCII.GetBytes(chave + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        var resp = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + aceita + "\r\n\r\n");
        ns.Write(resp, 0, resp.Length);

        // só um cliente por vez: o novo substitui o antigo
        Cliente antigo; lock (trava) { antigo = atual; atual = c; }
        if (antigo != null) { antigo.Vivo = false; try { antigo.Tcp.Close(); } catch { } }
        PararFontes();
        Log("Página conectada (" + origem + ")");
        c.Texto(new Dictionary<string, object> { { "tipo", "ola" }, { "versao", 1 }, { "rate", Rate }, { "canais", Canais } });

        var thApps = new Thread(() =>
        {
            while (c.Vivo)
            {
                try
                {
                    var estado = new Dictionary<string, object>();
                    lock (trava) { estado["modo"] = modoAtual; estado["capturando"] = new List<uint>(fontes.Keys); estado["erros"] = new List<string>(erros); }
                    c.Texto(new Dictionary<string, object> { { "tipo", "apps" }, { "apps", ListarApps() }, { "estado", estado } });
                }
                catch { }
                Thread.Sleep(400);
            }
        });
        thApps.IsBackground = true; thApps.Start();
        var thMix = new Thread(() => Misturador(c)); thMix.IsBackground = true; thMix.Start();

        // --- leitura de quadros do cliente ---
        try
        {
            while (c.Vivo)
            {
                int h0 = ns.ReadByte(), h1 = ns.ReadByte();
                if (h0 < 0 || h1 < 0) break;
                int op = h0 & 0x0F; bool mask = (h1 & 0x80) != 0; long len = h1 & 0x7F;
                if (len == 126) { len = (ns.ReadByte() << 8) | ns.ReadByte(); }
                else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | (long)(byte)ns.ReadByte(); }
                if (len > 65536) break;
                byte[] mk = new byte[4]; if (mask) Lido(ns, mk, 4);
                byte[] dados = new byte[len]; Lido(ns, dados, (int)len);
                if (mask) for (int i = 0; i < dados.Length; i++) dados[i] ^= mk[i % 4];
                if (op == 8) break;
                if (op == 9) { c.Enviar(10, dados, dados.Length); continue; }
                if (op == 1) Comando(Encoding.UTF8.GetString(dados));
            }
        }
        catch { }
        c.Vivo = false;
        lock (trava) { if (atual == c) atual = null; }
        PararFontes();
        Log("Página desconectada.");
    }

    static void Lido(Stream s, byte[] b, int n)
    {
        int lidos = 0;
        while (lidos < n) { int k = s.Read(b, lidos, n - lidos); if (k <= 0) throw new IOException(); lidos += k; }
    }

    static void Comando(string texto)
    {
        try
        {
            var o = Json.DeserializeObject(texto) as Dictionary<string, object>;
            if (o == null) return;
            string cmd = o.ContainsKey("cmd") ? o["cmd"] as string : null;
            if (cmd == "escolher")
            {
                var pids = new List<uint>();
                var arr = o.ContainsKey("pids") ? o["pids"] as System.Collections.IEnumerable : null;
                if (arr != null) foreach (var x in arr) pids.Add(Convert.ToUInt32(x));
                Escolher(o.ContainsKey("modo") ? (string)o["modo"] : "incluir", pids);
            }
            else if (cmd == "parar") PararFontes();
        }
        catch (Exception e) { Log("Comando inválido: " + e.Message); }
    }

    public static void Iniciar()
    {
        TcpListener l;
        try { l = new TcpListener(IPAddress.Loopback, Porta); l.Start(); }
        catch (Exception e) { Console.WriteLine("Não foi possível abrir a porta " + Porta + ": " + e.Message + "\nO assistente já está aberto em outra janela?"); return; }
        Log("Assistente de áudio ativo em 127.0.0.1:" + Porta + ". Deixe esta janela aberta.");
        Log("Abra o Compartilhar Tela, escolha \"Escolher aplicativos\" no áudio e marque o que quer transmitir.");
        while (true)
        {
            var tc = l.AcceptTcpClient();
            var c = new Cliente { Tcp = tc, Ns = tc.GetStream() };
            var t = new Thread(() => { try { Tratar(c); } catch { } finally { try { tc.Close(); } catch { } } });
            t.IsBackground = true; t.Start();
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $codigo -Language CSharp -ReferencedAssemblies 'System.Web.Extensions' -IgnoreWarnings
} catch {
  Write-Host 'Não foi possível preparar o assistente neste Windows:' -ForegroundColor Red
  Write-Host $_.Exception.Message
  return
}
$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19041) {
  Write-Host "Este Windows (build $build) é antigo demais: a captura por aplicativo exige o Windows 10 versão 2004 (19041) ou mais novo." -ForegroundColor Yellow
  return
}
Write-Host ''
Write-Host '  Compartilhar Tela - Assistente de áudio' -ForegroundColor Green
Write-Host '  Só aceita conexões deste computador e da página do Compartilhar Tela.' -ForegroundColor DarkGray
Write-Host ''
[Assistente]::Iniciar()
