using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class GameControls
{
    private const int KeyboardHook = 13;
    private const uint Injected = 0x10, KeyUp = 2, Extended = 1, ScanCode = 8;
    private static readonly Dictionary<int, int> Bindings = new Dictionary<int, int>();
    private static readonly Dictionary<int, int> PadBindings = new Dictionary<int, int>();
    private static readonly Dictionary<int, KeyboardInput> PadHeld = new Dictionary<int, KeyboardInput>();
    private static readonly ushort[] PadMasks = {
        0x1000, 0x2000, 0x4000, 0x8000, 0x0100, 0x0200, 0, 0,
        0x0020, 0x0010, 0x0040, 0x0080, 0x0001, 0x0002, 0x0004, 0x0008
    };
    private static readonly Dictionary<int, KeyboardInput> Held = new Dictionary<int, KeyboardInput>();
    private static readonly Dictionary<uint, Process> Related = new Dictionary<uint, Process>();
    private static readonly Hook Callback = HandleKey;
    private static IntPtr hook;
    private static uint rootId;
    private static long lastSeen;
    private static long nextSnapshot;
    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static bool actionFailed;
    private static bool fullscreenFailed;
    private static Process launcher;

    [STAThread]
    private static int Main(string[] args)
    {
        int parentId;
        if (args.Length == 2 && args[0] == "browser-arrows" && int.TryParse(args[1], out parentId))
            return WatchBrowserArrows(parentId);
        int gameId, launcherId;
        if (args.Length < 3 || !int.TryParse(args[0], out gameId) || !int.TryParse(args[1], out launcherId))
            return 2;
        try { launcher = Process.GetProcessById(launcherId); }
        catch (ArgumentException) { return 0; }
        rootId = (uint)gameId;
        Track(rootId);
        RefreshRelated();
        bool fullscreen = false;
        for (int i = 2; i < args.Length; i++) {
            if (args[i] == "fullscreen") {
                fullscreen = true;
                continue;
            }
            string[] pair = args[i].Split(':');
            int source, target;
            if (pair.Length == 3 && pair[0] == "pad" && int.TryParse(pair[1], out source) &&
                int.TryParse(pair[2], out target) && source >= 0 && source < PadMasks.Length &&
                target >= 1 && target <= 254) {
                PadBindings[source] = target;
                continue;
            }
            if (pair.Length != 2 || !int.TryParse(pair[0], out source) || !int.TryParse(pair[1], out target) ||
                source < 1 || source > 254 || target < 1 || target > 254) return 2;
            Bindings[source] = target;
        }
        if (Bindings.Count > 0) {
            hook = SetWindowsHookEx(KeyboardHook, Callback, GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero) return 3;
        }
        IntPtr fullscreenWindow = IntPtr.Zero;
        long fullscreenReadyAt = 0;
        long fullscreenReleaseAt = 0;
        KeyboardInput fullscreenKey = new KeyboardInput();
        using (var timer = new Timer()) {
            timer.Interval = PadBindings.Count > 0 ? 16 : 40;
            timer.Tick += delegate {
                if (Clock.ElapsedMilliseconds >= nextSnapshot) RefreshRelated();
                if (launcher.HasExited || Clock.ElapsedMilliseconds - lastSeen > 2000 || actionFailed ||
                    (!fullscreen && fullscreenReleaseAt == 0 && Bindings.Count == 0 && PadBindings.Count == 0)) {
                    Application.ExitThread();
                    return;
                }
                IntPtr window = GetForegroundWindow();
                uint thread = GameWindowThread(window);
                if (fullscreenReleaseAt != 0 && (window != fullscreenWindow || Clock.ElapsedMilliseconds >= fullscreenReleaseAt)) {
                    fullscreenFailed = !SendKey(fullscreenKey, true);
                    fullscreenReleaseAt = 0;
                }
                if (fullscreen) {
                    if (thread == 0) fullscreenWindow = IntPtr.Zero;
                    else if (window != fullscreenWindow) {
                        fullscreenWindow = window;
                        fullscreenReadyAt = Clock.ElapsedMilliseconds + 1000;
                    } else if (Clock.ElapsedMilliseconds >= fullscreenReadyAt && window == GetForegroundWindow()) {
                        fullscreen = false;
                        if (!FillsScreen(window)) {
                            fullscreenKey = BuildKey(0x73, GetKeyboardLayout(thread));
                            fullscreenFailed = !SendKey(fullscreenKey, false);
                            if (!fullscreenFailed) fullscreenReleaseAt = Clock.ElapsedMilliseconds + 90;
                        }
                    }
                }
                if (thread == 0) ReleaseHeld();
                else if (PadBindings.Count > 0) PollGamepad(thread);
            };
            timer.Start();
            try { Application.Run(); }
            finally {
                if (fullscreenReleaseAt != 0) SendKey(fullscreenKey, true);
                ReleaseHeld();
                if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
                foreach (var process in Related.Values) process.Dispose();
                launcher.Dispose();
            }
        }
        return actionFailed ? 4 : fullscreenFailed ? 5 : 0;
    }

    private static int WatchBrowserArrows(int parentId)
    {
        using (var parent = Process.GetProcessById(parentId))
        using (var output = Console.OpenStandardOutput()) {
            int lastState = -1;
            while (!parent.HasExited) {
                uint owner;
                GetWindowThreadProcessId(GetForegroundWindow(), out owner);
                int state = 0;
                if (owner == (uint)parentId &&
                    !IsKeyDown(0x10) && !IsKeyDown(0x11) && !IsKeyDown(0x12) &&
                    !IsKeyDown(0x5B) && !IsKeyDown(0x5C)) {
                    // VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN.
                    for (int index = 0; index < 4; index++)
                        if (IsKeyDown(0x25 + index)) state |= 1 << index;
                }
                if (state != lastState) {
                    output.WriteByte((byte)state);
                    output.Flush();
                    lastState = state;
                }
                System.Threading.Thread.Sleep(8);
            }
        }
        return 0;
    }

    private static bool IsKeyDown(int key)
    {
        return (GetAsyncKeyState(key) & 0x8000) != 0;
    }

    private static void Track(uint id)
    {
        if (Related.ContainsKey(id)) return;
        try {
            var process = Process.GetProcessById((int)id);
            if (!process.HasExited) Related.Add(id, process);
            else process.Dispose();
        } catch (ArgumentException) {}
    }

    private static void RefreshRelated()
    {
        nextSnapshot = Clock.ElapsedMilliseconds + 200;
        var parents = new HashSet<uint>(Related.Keys);
        if (Clock.ElapsedMilliseconds < 2000) parents.Add(rootId);
        var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot != new IntPtr(-1)) {
            try {
                var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
                var children = new List<ProcessEntry>();
                if (Process32First(snapshot, ref entry)) {
                    do { children.Add(entry); } while (Process32Next(snapshot, ref entry));
                }
                bool added;
                do {
                    added = false;
                    foreach (var process in children) {
                        if (parents.Contains(process.ParentId) && parents.Add(process.Id)) {
                            Track(process.Id);
                            added = true;
                        }
                    }
                } while (added);
            } finally { CloseHandle(snapshot); }
        }
        foreach (uint id in new List<uint>(Related.Keys)) {
            if (Related[id].HasExited) {
                Related[id].Dispose();
                Related.Remove(id);
            }
        }
        if (Related.Count > 0) lastSeen = Clock.ElapsedMilliseconds;
    }

    private static uint ForegroundGameThread()
    {
        return GameWindowThread(GetForegroundWindow());
    }

    private static uint GameWindowThread(IntPtr window)
    {
        uint owner;
        uint thread = GetWindowThreadProcessId(window, out owner);
        return Related.ContainsKey(owner) ? thread : 0;
    }

    private static bool FillsScreen(IntPtr window)
    {
        WindowRect rect;
        const int Caption = 0x00C00000;
        if ((GetWindowLong(window, -16) & Caption) == Caption || !GetWindowRect(window, out rect)) return false;
        Rectangle bounds = Screen.FromHandle(window).Bounds;
        return rect.Left <= bounds.Left + 2 && rect.Top <= bounds.Top + 2 &&
            rect.Right >= bounds.Right - 2 && rect.Bottom >= bounds.Bottom - 2;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowRect
    {
        public int Left, Top, Right, Bottom;
    }

    private static IntPtr HandleKey(int code, IntPtr message, IntPtr data)
    {
        if (code < 0) return CallNextHookEx(hook, code, message, data);
        var key = (HookKey)Marshal.PtrToStructure(data, typeof(HookKey));
        if ((key.Flags & Injected) != 0) return CallNextHookEx(hook, code, message, data);
        int kind = message.ToInt32();
        bool down = kind == 0x100 || kind == 0x104;
        bool up = kind == 0x101 || kind == 0x105;
        int source = (int)key.Key;
        KeyboardInput simulated;
        if (up && Held.TryGetValue(source, out simulated)) {
            Held.Remove(source);
            if (!PadHeld.ContainsValue(simulated)) SendKey(simulated, true);
            return new IntPtr(1);
        }
        int target;
        if (down && Bindings.TryGetValue(source, out target)) {
            uint thread = ForegroundGameThread();
            if (thread != 0) {
                if (!Held.TryGetValue(source, out simulated)) simulated = BuildKey(target, GetKeyboardLayout(thread));
                if (SendKey(simulated, false)) {
                    Held[source] = simulated;
                    return new IntPtr(1);
                }
                actionFailed = true;
            }
        }
        return CallNextHookEx(hook, code, message, data);
    }

    private static void ReleaseHeld()
    {
        foreach (var key in Held.Values) SendKey(key, true);
        Held.Clear();
        foreach (var key in PadHeld.Values) SendKey(key, true);
        PadHeld.Clear();
    }

    private static bool PadButtonPressed(PadState state, int button)
    {
        if (button == 6) return state.LeftTrigger >= 128;
        if (button == 7) return state.RightTrigger >= 128;
        return (state.Buttons & PadMasks[button]) != 0;
    }

    private static void PollGamepad(uint thread)
    {
        var pressed = new HashSet<int>();
        for (uint controller = 0; controller < 4; controller++) {
            PadState state;
            if (XInputGetState(controller, out state) != 0) continue;
            foreach (int button in PadBindings.Keys) {
                if (PadButtonPressed(state, button)) pressed.Add(button);
            }
        }
        foreach (var entry in PadBindings) {
            KeyboardInput key;
            bool held = PadHeld.TryGetValue(entry.Key, out key);
            if (pressed.Contains(entry.Key) && !held) {
                key = BuildKey(entry.Value, GetKeyboardLayout(thread));
                if (SendKey(key, false)) PadHeld[entry.Key] = key;
                else actionFailed = true;
            } else if (!pressed.Contains(entry.Key) && held) {
                PadHeld.Remove(entry.Key);
                if (!Held.ContainsValue(key)) SendKey(key, true);
            }
        }
    }

    private static KeyboardInput BuildKey(int key, IntPtr layout)
    {
        uint code = MapVirtualKeyEx((uint)key, 4, layout);
        if ((code & 0xff) == 0) return new KeyboardInput { Key = (ushort)key };
        // Some layouts return the low byte alone for the navigation cluster.
        bool extended = (code & 0xff00) == 0xe000 || (key >= 33 && key <= 40) ||
            key == 45 || key == 46 || key == 163;
        uint flags = ScanCode | (extended ? Extended : 0);
        return new KeyboardInput { ScanCode = (ushort)(code & 0xff), Flags = flags };
    }

    private static bool SendKey(KeyboardInput key, bool up)
    {
        if (up) key.Flags |= KeyUp;
        var input = new Input { Type = 1, Data = new InputData { Keyboard = key } };
        return SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) == 1;
    }

    private delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)]
    private struct HookKey { public uint Key, ScanCode, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint Type; public InputData Data; }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputData {
        [FieldOffset(0)] public KeyboardInput Keyboard;
        [FieldOffset(0)] public MouseInput Mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput { public ushort Key, ScanCode; public uint Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)]
    private struct PadState {
        public uint Packet;
        public ushort Buttons;
        public byte LeftTrigger, RightTrigger;
        public short LeftX, LeftY, RightX, RightY;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry {
        public uint Size, Usage, Id;
        public UIntPtr Heap;
        public uint ModuleId, Threads, ParentId;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint process);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW")] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW")] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll", EntryPoint = "SetWindowsHookExW")] private static extern IntPtr SetWindowsHookEx(int type, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr handle, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out WindowRect rect);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] private static extern IntPtr GetKeyboardLayout(uint thread);
    [DllImport("user32.dll", EntryPoint = "MapVirtualKeyExW")] private static extern uint MapVirtualKeyEx(uint key, uint type, IntPtr layout);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("xinput1_4.dll")] private static extern uint XInputGetState(uint controller, out PadState state);
}
