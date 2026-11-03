# Neuro Ninja local server (Windows, nothing to install).
#   - Serves the app at http://localhost:8770
#   - GET /api/ports              lists this computer's COM ports for the Port menu
#   - WS  /api/serial?port=COM3   relays one serial port to the page
# Only pages from this same localhost address may use the serial relay.
#
# Usage:  powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8765] [-Open]
param([int]$Port = 8770, [switch]$Open)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Ports;
using System.Management;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

public static class NpServer
{
    static string Root;
    static int Port;
    static readonly object OpenLock = new object();
    static readonly HashSet<string> OpenPorts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static readonly object CacheLock = new object();
    static string CacheKey = null;
    static DateTime CacheTime = DateTime.MinValue;
    static Dictionary<string, string[]> CacheInfo = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, string> Types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" },
        { ".css", "text/css; charset=utf-8" },
        { ".js", "text/javascript; charset=utf-8" },
        { ".json", "application/json; charset=utf-8" },
        { ".md", "text/markdown; charset=utf-8" },
        { ".svg", "image/svg+xml" },
        { ".png", "image/png" },
        { ".ico", "image/x-icon" }
    };

    /* Returns the process exit code. Non-zero makes the launcher pause, so
       a failure message stays on screen instead of the window vanishing. */
    public static int Run(string root, int port, bool open)
    {
        Root = Path.GetFullPath(root).TrimEnd('\\') + "\\";
        Port = port;
        string url = "http://localhost:" + port + "/";
        HttpListener listener = new HttpListener();
        listener.Prefixes.Add(url);
        listener.IgnoreWriteExceptions = true;
        try
        {
            listener.Start();
        }
        catch (HttpListenerException ex)
        {
            // 183 (already exists): this address is registered already, which
            // means the app is running. Anything else is a real failure that
            // used to be reported the same way, then the window closed.
            if (ex.ErrorCode == 183)
            {
                Console.WriteLine("Neuro Ninja is already running at " + url + " - opening it.");
                if (open) OpenBrowser(url);
                return 0;
            }
            Console.WriteLine("Couldn't start on port " + port + ": " + ex.Message + " (error " + ex.ErrorCode + ").");
            Console.WriteLine("Another program may be using the port. Close it, or run: serve.ps1 -Port 8771 -Open");
            return 1;
        }
        try { Console.CancelKeyPress += delegate { try { listener.Stop(); } catch (Exception) { } Environment.Exit(0); }; }
        catch (Exception) { }
        Console.WriteLine("Neuro Ninja is running at " + url + "   (keep this window open; Ctrl+C to stop)");
        if (open) OpenBrowser(url);
        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); }
            catch (Exception ex)
            {
                // Stopped on purpose: leave. Otherwise one bad request (a client
                // dropping mid-headers, say) used to end the server silently;
                // log it and keep serving. The pause stops a tight error loop.
                if (!listener.IsListening) break;
                Console.WriteLine("A request failed and was skipped: " + ex.Message);
                Thread.Sleep(20);
                continue;
            }
            ThreadPool.QueueUserWorkItem(delegate { Handle(ctx); });
        }
        return 0;
    }

    /* Requests from this computer only. For a localhost address http.sys
       listens on every network interface and picks the site by the Host
       header alone, so without this the Windows Firewall would be the only
       thing between another machine on the network and the serial port. */
    static bool FromThisComputer(HttpListenerRequest req)
    {
        IPEndPoint ep = req.RemoteEndPoint;
        if (ep == null) return false;
        IPAddress a = ep.Address;
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        return IPAddress.IsLoopback(a);
    }

    static void OpenBrowser(string url)
    {
        try { Process.Start(url); } catch (Exception) { }
    }

    static void Handle(HttpListenerContext ctx)
    {
        try
        {
            if (!FromThisComputer(ctx.Request)) { ctx.Response.StatusCode = 403; ctx.Response.Close(); return; }
            string path = ctx.Request.Url.AbsolutePath;
            if (path == "/api/ports") Ports(ctx);
            else if (path == "/api/serial") Serial(ctx).Wait();
            else StaticFile(ctx);
        }
        catch (Exception ex)
        {
            Console.WriteLine("Request error: " + Inner(ex).Message);
            try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch (Exception) { }
        }
    }

    /* Browsers always send Origin on WebSocket and cross-site requests; only
       this server's own pages may list or open ports. */
    static bool OriginOk(HttpListenerRequest req)
    {
        string origin = req.Headers["Origin"];
        if (string.IsNullOrEmpty(origin)) return true;
        return origin == "http://localhost:" + Port || origin == "http://127.0.0.1:" + Port;
    }

    static void Ports(HttpListenerContext ctx)
    {
        if (!OriginOk(ctx.Request)) { ctx.Response.StatusCode = 403; ctx.Response.Close(); return; }
        List<string> names = new List<string>();
        foreach (string raw in SerialPort.GetPortNames())
        {
            string n = raw.Trim().ToUpperInvariant();
            if (Regex.IsMatch(n, "^COM[0-9]+$") && !names.Contains(n)) names.Add(n);
        }
        names.Sort(ComCompare);

        Dictionary<string, string[]> info;
        string key = string.Join(",", names.ToArray());
        lock (CacheLock)
        {
            if (key != CacheKey || (DateTime.UtcNow - CacheTime).TotalSeconds > 30)
            {
                CacheInfo = QueryFriendlyNames();
                CacheKey = key;
                CacheTime = DateTime.UtcNow;
            }
            info = CacheInfo;
        }

        StringBuilder sb = new StringBuilder("{\"ok\":true,\"ports\":[");
        for (int i = 0; i < names.Count; i++)
        {
            string n = names[i];
            string[] inf;
            if (!info.TryGetValue(n, out inf)) inf = new string[] { "", "", "" };
            bool inUse;
            lock (OpenLock) inUse = OpenPorts.Contains(n);
            if (i > 0) sb.Append(',');
            sb.Append("{\"path\":").Append(Json(n))
              .Append(",\"name\":").Append(Json(inf[0]))
              .Append(",\"vid\":").Append(Json(inf[1]))
              .Append(",\"pid\":").Append(Json(inf[2]))
              .Append(",\"inUse\":").Append(inUse ? "true" : "false")
              .Append('}');
        }
        sb.Append("]}");
        WriteText(ctx, 200, "application/json; charset=utf-8", sb.ToString());
    }

    static Dictionary<string, string[]> QueryFriendlyNames()
    {
        Dictionary<string, string[]> map = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using (ManagementObjectSearcher s = new ManagementObjectSearcher("SELECT Name, PNPDeviceID FROM Win32_PnPEntity WHERE Name LIKE '%(COM%'"))
            using (ManagementObjectCollection results = s.Get())
            {
                foreach (ManagementBaseObject mo in results)
                {
                    string name = Convert.ToString(mo["Name"]);
                    string pnp = Convert.ToString(mo["PNPDeviceID"]);
                    Match m = Regex.Match(name, @"\((COM[0-9]+)\)");
                    if (!m.Success) continue;
                    Match v = Regex.Match(pnp, "VID_([0-9A-Fa-f]{4})");
                    Match p = Regex.Match(pnp, "PID_([0-9A-Fa-f]{4})");
                    map[m.Groups[1].Value.ToUpperInvariant()] = new string[] {
                        name,
                        v.Success ? v.Groups[1].Value.ToUpperInvariant() : "",
                        p.Success ? p.Groups[1].Value.ToUpperInvariant() : ""
                    };
                }
            }
        }
        catch (Exception) { }
        return map;
    }

    static async Task Serial(HttpListenerContext ctx)
    {
        if (!ctx.Request.IsWebSocketRequest || !OriginOk(ctx.Request))
        {
            ctx.Response.StatusCode = 400;
            ctx.Response.Close();
            return;
        }
        string portName = (ctx.Request.QueryString["port"] ?? "").Trim().ToUpperInvariant();
        int baud;
        if (!int.TryParse(ctx.Request.QueryString["baud"], out baud) || baud <= 0) baud = 115200;
        HttpListenerWebSocketContext wsc = await ctx.AcceptWebSocketAsync(null);
        WebSocket ws = wsc.WebSocket;

        SerialPort sp = null;
        string error = null;
        try
        {
            if (!Regex.IsMatch(portName, "^COM[0-9]{1,3}$")) throw new ArgumentException("Invalid port name \"" + portName + "\".");
            sp = new SerialPort(portName, baud, Parity.None, 8, StopBits.One);
            sp.ReadBufferSize = 1 << 16;
            sp.DtrEnable = true;   // same line states as pyserial, which NeuroPawn's own tools use
            sp.RtsEnable = true;
            sp.Open();
        }
        catch (UnauthorizedAccessException)
        {
            error = portName + " is in use by another program (for example EXG Visualizer+, the NeuroPawn EXG Visualizer, the LSL streamer or a serial monitor). Close it and try again.";
        }
        catch (IOException)
        {
            error = portName + " isn't available. Check that the board is plugged in, then refresh the port list.";
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }
        if (error != null)
        {
            if (sp != null) sp.Dispose();
            Console.WriteLine("Could not open " + portName + ": " + error);
            try
            {
                await SendText(ws, "{\"type\":\"error\",\"message\":" + Json(error) + "}");
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
            }
            catch (Exception) { }
            ws.Dispose();
            return;
        }

        lock (OpenLock) OpenPorts.Add(portName);
        Console.WriteLine("Opened " + portName + " at " + baud + " baud");
        SemaphoreSlim sendLock = new SemaphoreSlim(1, 1);
        CancellationTokenSource cts = new CancellationTokenSource();
        bool ready = true;
        try { await SendText(ws, "{\"type\":\"opened\",\"port\":" + Json(portName) + "}"); }
        catch (Exception) { ready = false; }

        Thread reader = null;
        if (ready)
        {
            reader = new Thread(delegate ()
            {
                byte[] buf = new byte[4096];
                try
                {
                    Stream stream = sp.BaseStream;
                    while (!cts.IsCancellationRequested)
                    {
                        int n = stream.Read(buf, 0, buf.Length);
                        if (n <= 0) continue;
                        sendLock.Wait();
                        try { ws.SendAsync(new ArraySegment<byte>(buf, 0, n), WebSocketMessageType.Binary, true, CancellationToken.None).Wait(); }
                        finally { sendLock.Release(); }
                    }
                }
                catch (Exception ex)
                {
                    if (!cts.IsCancellationRequested)
                    {
                        Console.WriteLine(portName + " read error: " + Inner(ex).Message);
                        try
                        {
                            sendLock.Wait();
                            try { SendText(ws, "{\"type\":\"error\",\"message\":" + Json("Lost connection to " + portName + ". The board may have been unplugged.") + "}").Wait(); }
                            finally { sendLock.Release(); }
                        }
                        catch (Exception) { }
                        cts.Cancel();
                    }
                }
            });
            reader.IsBackground = true;
            reader.Start();
        }

        byte[] rbuf = new byte[256];
        MemoryStream msg = new MemoryStream();
        while (ready && ws.State == WebSocketState.Open && !cts.IsCancellationRequested)
        {
            WebSocketReceiveResult r;
            try { r = await ws.ReceiveAsync(new ArraySegment<byte>(rbuf), cts.Token); }
            catch (Exception) { break; }
            if (r.MessageType == WebSocketMessageType.Close) break;
            msg.Write(rbuf, 0, r.Count);
            if (!r.EndOfMessage)
            {
                if (msg.Length > 4096) break;
                continue;
            }
            byte[] data = msg.ToArray();
            msg.SetLength(0);
            if (r.MessageType != WebSocketMessageType.Text || data.Length == 0 || data.Length > 64) continue;
            try
            {
                sp.Write(data, 0, data.Length);
                Console.WriteLine(portName + " <- " + Encoding.ASCII.GetString(data));
            }
            catch (Exception ex)
            {
                Console.WriteLine(portName + " write error: " + ex.Message);
                break;
            }
        }

        cts.Cancel();
        try { sp.Close(); } catch (Exception) { }
        if (reader != null) reader.Join(2000);
        lock (OpenLock) OpenPorts.Remove(portName);
        Console.WriteLine("Closed " + portName);
        try
        {
            if (ws.State == WebSocketState.Open || ws.State == WebSocketState.CloseReceived)
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
        }
        catch (Exception) { }
        ws.Dispose();
    }

    static void StaticFile(HttpListenerContext ctx)
    {
        HttpListenerResponse res = ctx.Response;
        string rel = Uri.UnescapeDataString(ctx.Request.Url.AbsolutePath).TrimStart('/');
        if (rel.Length == 0) rel = "index.html";
        string full;
        try { full = Path.GetFullPath(Path.Combine(Root, rel.Replace('/', '\\'))); }
        catch (Exception) { res.StatusCode = 400; res.Close(); return; }
        if (!full.StartsWith(Root, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
        {
            res.StatusCode = 404;
            res.Close();
            return;
        }
        byte[] bytes = File.ReadAllBytes(full);
        string type;
        if (!Types.TryGetValue(Path.GetExtension(full), out type)) type = "application/octet-stream";
        res.ContentType = type;
        res.Headers.Add("Cache-Control", "no-store");
        res.ContentLength64 = bytes.Length;
        if (ctx.Request.HttpMethod != "HEAD") res.OutputStream.Write(bytes, 0, bytes.Length);
        res.Close();
    }

    static void WriteText(HttpListenerContext ctx, int status, string type, string body)
    {
        byte[] b = Encoding.UTF8.GetBytes(body);
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = type;
        ctx.Response.Headers.Add("Cache-Control", "no-store");
        ctx.Response.ContentLength64 = b.Length;
        if (ctx.Request.HttpMethod != "HEAD") ctx.Response.OutputStream.Write(b, 0, b.Length);
        ctx.Response.Close();
    }

    static Task SendText(WebSocket ws, string text)
    {
        byte[] b = Encoding.UTF8.GetBytes(text);
        return ws.SendAsync(new ArraySegment<byte>(b), WebSocketMessageType.Text, true, CancellationToken.None);
    }

    static int ComNumber(string s)
    {
        int n;
        return s.Length > 3 && int.TryParse(s.Substring(3), out n) ? n : int.MaxValue;
    }

    static int ComCompare(string a, string b)
    {
        int c = ComNumber(a).CompareTo(ComNumber(b));
        return c != 0 ? c : string.Compare(a, b, StringComparison.OrdinalIgnoreCase);
    }

    static Exception Inner(Exception e)
    {
        while (e is AggregateException && e.InnerException != null) e = e.InnerException;
        return e;
    }

    static string Json(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies System.Management
exit ([NpServer]::Run($PSScriptRoot, $Port, $Open.IsPresent))
