# Enumerates every Plug-and-Play device Windows knows about — including disconnected ("phantom")
# devices it remembers — plus every port of every connected USB hub, and prints
# { Devices: [...], Ports: [...] } as JSON for main.js.
#
# Device properties (parent, location paths, driver info, ...) are read straight from the
# Configuration Manager API (CfgMgr32). Win32_PnPEntity has no LocationPaths property, and
# Get-PnpDeviceProperty is ~200 ms per device and misattributes results when given many IDs.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('PorterDevProps' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class PorterDevInfo {
  public string Parent;
  public string LocationInfo;
  public string[] LocationPaths = new string[0];
  public string DriverVersion;
  public string DriverProvider;
  public string DriverDate;
  public string Enumerator;
  public string HardwareId;
  public string BusDescription;
}

public static class PorterDevProps {
  [StructLayout(LayoutKind.Sequential)]
  struct DEVPROPKEY { public Guid fmtid; public uint pid; }

  [DllImport("CfgMgr32.dll", CharSet = CharSet.Unicode)]
  static extern int CM_Locate_DevNodeW(out uint devInst, string deviceId, uint flags);

  [DllImport("CfgMgr32.dll", CharSet = CharSet.Unicode)]
  static extern int CM_Get_DevNode_PropertyW(uint devInst, ref DEVPROPKEY key, out uint type, byte[] buffer, ref uint size, uint flags);

  const uint CM_LOCATE_DEVNODE_PHANTOM = 1;
  const int CR_SUCCESS = 0;
  const int CR_BUFFER_SMALL = 0x1A;
  const uint DEVPROP_TYPE_FILETIME = 0x10;

  static DEVPROPKEY Key(string guid, uint pid) { var k = new DEVPROPKEY(); k.fmtid = new Guid(guid); k.pid = pid; return k; }
  const string DEVICE = "a45c254e-df1c-4efd-8020-67d146a850e0";
  const string DRIVER = "a8b865dd-2e3d-4094-ad97-e593a70c75d6";
  static readonly DEVPROPKEY LocationPaths  = Key(DEVICE, 37);
  static readonly DEVPROPKEY LocationInfo   = Key(DEVICE, 15);
  static readonly DEVPROPKEY HardwareIds    = Key(DEVICE, 3);
  static readonly DEVPROPKEY EnumeratorName = Key(DEVICE, 24);
  static readonly DEVPROPKEY Parent         = Key("4340a6c5-93fa-4706-972c-7b648008a5a7", 8);
  static readonly DEVPROPKEY BusDesc        = Key("540b947e-8b40-45bc-a8a2-6a0b894cbda2", 4);
  static readonly DEVPROPKEY DriverDate     = Key(DRIVER, 2);
  static readonly DEVPROPKEY DriverVersion  = Key(DRIVER, 3);
  static readonly DEVPROPKEY DriverProvider = Key(DRIVER, 9);

  static byte[] Raw(uint devInst, DEVPROPKEY key, out uint type) {
    uint size = 0;
    int cr = CM_Get_DevNode_PropertyW(devInst, ref key, out type, null, ref size, 0);
    if (cr != CR_BUFFER_SMALL || size == 0) return null;
    byte[] buf = new byte[size];
    cr = CM_Get_DevNode_PropertyW(devInst, ref key, out type, buf, ref size, 0);
    return cr == CR_SUCCESS ? buf : null;
  }

  static string Str(uint devInst, DEVPROPKEY key) {
    uint type;
    byte[] buf = Raw(devInst, key, out type);
    return buf == null ? null : Encoding.Unicode.GetString(buf).TrimEnd('\0');
  }

  static string[] List(uint devInst, DEVPROPKEY key) {
    string s = Str(devInst, key);
    return String.IsNullOrEmpty(s) ? new string[0] : s.Split(new[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
  }

  static string Date(uint devInst, DEVPROPKEY key) {
    uint type;
    byte[] buf = Raw(devInst, key, out type);
    if (buf == null || type != DEVPROP_TYPE_FILETIME || buf.Length < 8) return null;
    return DateTime.FromFileTimeUtc(BitConverter.ToInt64(buf, 0)).ToString("yyyy-MM-dd");
  }

  [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool SetupDiGetClassDescriptionW(ref Guid classGuid, StringBuilder description, uint size, out uint required);

  // The category name Device Manager shows, e.g. "Sound, video and game controllers".
  public static string ClassTitle(string classGuid) {
    Guid g;
    if (String.IsNullOrEmpty(classGuid) || !Guid.TryParse(classGuid, out g)) return null;
    var sb = new StringBuilder(256);
    uint required;
    return SetupDiGetClassDescriptionW(ref g, sb, (uint)sb.Capacity, out required) ? sb.ToString() : null;
  }

  public static PorterDevInfo Lookup(string instanceId) {
    var info = new PorterDevInfo();
    uint devInst;
    if (CM_Locate_DevNodeW(out devInst, instanceId, CM_LOCATE_DEVNODE_PHANTOM) != CR_SUCCESS) return info;
    info.Parent = Str(devInst, Parent);
    info.LocationInfo = Str(devInst, LocationInfo);
    info.LocationPaths = List(devInst, LocationPaths);
    info.DriverVersion = Str(devInst, DriverVersion);
    info.DriverProvider = Str(devInst, DriverProvider);
    info.DriverDate = Date(devInst, DriverDate);
    info.Enumerator = Str(devInst, EnumeratorName);
    var hw = List(devInst, HardwareIds);
    info.HardwareId = hw.Length > 0 ? hw[0] : null;
    info.BusDescription = Str(devInst, BusDesc);
    return info;
  }
}

public class PorterPort {
  public string Hub;            // instance ID of the hub this port belongs to
  public int Port;              // 1-based port number on that hub
  public bool Connectable;      // firmware says a user can plug something in here (ACPI _UPC)
  public bool TypeC;
  public bool Usb2;             // port speaks USB 2.0 / 1.1
  public bool Usb3;             // port speaks USB 3.x (SuperSpeed)
  public int CompanionPort;     // the other half of the same physical socket (0 = none)
  public string CompanionHub;   // hub of the companion port (null = same hub)
  public bool Connected;        // something is plugged in right now
  public int Speed;             // 0 low, 1 full, 2 high, 3 SuperSpeed (only when Connected)
}

// Asks a USB hub about each of its ports (what USBView shows). Read-only; no admin needed.
public static class PorterHubs {
  [DllImport("CfgMgr32.dll", CharSet = CharSet.Unicode)]
  static extern int CM_Get_Device_Interface_List_SizeW(out uint len, ref Guid cls, string devId, uint flags);
  [DllImport("CfgMgr32.dll", CharSet = CharSet.Unicode)]
  static extern int CM_Get_Device_Interface_ListW(ref Guid cls, string devId, char[] buf, uint len, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(Microsoft.Win32.SafeHandles.SafeFileHandle h, uint code, byte[] inBuf, int inLen, byte[] outBuf, int outLen, out int returned, IntPtr overlapped);

  static readonly Guid GUID_DEVINTERFACE_USB_HUB = new Guid("f18a0e88-c30c-11d0-8815-00a0c906bed8");
  const uint GENERIC_WRITE = 0x40000000, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;
  // CTL_CODE(FILE_DEVICE_USB, function, METHOD_BUFFERED, FILE_ANY_ACCESS)
  const uint IOCTL_USB_GET_NODE_INFORMATION                  = 0x220408; // 258
  const uint IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX    = 0x220448; // 274
  const uint IOCTL_USB_GET_PORT_CONNECTOR_PROPERTIES         = 0x220458; // 278
  const uint IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX_V2 = 0x22045C; // 279

  static string HubInterface(string instanceId) {
    Guid g = GUID_DEVINTERFACE_USB_HUB; uint len;
    if (CM_Get_Device_Interface_List_SizeW(out len, ref g, instanceId, 0) != 0 || len < 2) return null;
    var buf = new char[len];
    if (CM_Get_Device_Interface_ListW(ref g, instanceId, buf, len, 0) != 0) return null;
    string first = new string(buf).Split('\0')[0];
    return first.Length > 0 ? first : null;
  }

  // "\\?\USB#ROOT_HUB30#7&dacba&0&0#{f18a0e88-...}"  ->  "USB\ROOT_HUB30\7&dacba&0&0"
  static string InstanceFromLink(string link) {
    if (String.IsNullOrEmpty(link)) return null;
    string s = link;
    if (s.StartsWith(@"\\?\") || s.StartsWith(@"\??\")) s = s.Substring(4);
    int brace = s.LastIndexOf("#{");
    if (brace > 0) s = s.Substring(0, brace);
    return s.Replace('#', '\\');
  }

  public static PorterPort[] Ports(string instanceId) {
    var result = new System.Collections.Generic.List<PorterPort>();
    string path = HubInterface(instanceId);
    if (path == null) return result.ToArray();

    using (var h = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero)) {
      if (h.IsInvalid) return result.ToArray();
      int ret;
      var node = new byte[76];
      if (!DeviceIoControl(h, IOCTL_USB_GET_NODE_INFORMATION, node, node.Length, node, node.Length, out ret, IntPtr.Zero)) return result.ToArray();
      int count = node[6]; // USB_NODE_INFORMATION.HubInformation.HubDescriptor.bNumberOfPorts

      for (int p = 1; p <= count; p++) {
        var port = new PorterPort { Hub = instanceId, Port = p };

        // Connector: user-connectable, Type-C, companion (these structs are pack(1)).
        var conn = new byte[512];
        BitConverter.GetBytes(p).CopyTo(conn, 0);
        if (DeviceIoControl(h, IOCTL_USB_GET_PORT_CONNECTOR_PROPERTIES, conn, conn.Length, conn, conn.Length, out ret, IntPtr.Zero)) {
          uint flags = BitConverter.ToUInt32(conn, 8);
          port.Connectable = (flags & 1) != 0;
          port.TypeC = (flags & 8) != 0;
          port.CompanionPort = BitConverter.ToUInt16(conn, 14);
          int actual = Math.Min(BitConverter.ToInt32(conn, 4), conn.Length);
          if (actual > 18) port.CompanionHub = InstanceFromLink(Encoding.Unicode.GetString(conn, 16, actual - 16).TrimEnd('\0'));
        }

        // Supported protocols for the port (USB 2 / USB 3).
        var v2 = new byte[16];
        BitConverter.GetBytes(p).CopyTo(v2, 0);
        BitConverter.GetBytes(16).CopyTo(v2, 4);
        BitConverter.GetBytes(7).CopyTo(v2, 8); // we understand USB 1.1, 2.0 and 3.x
        if (DeviceIoControl(h, IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX_V2, v2, v2.Length, v2, v2.Length, out ret, IntPtr.Zero)) {
          uint protocols = BitConverter.ToUInt32(v2, 8);
          port.Usb2 = (protocols & 3) != 0;
          port.Usb3 = (protocols & 4) != 0;
        }

        // What is plugged in right now.
        var info = new byte[512];
        BitConverter.GetBytes(p).CopyTo(info, 0);
        if (DeviceIoControl(h, IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX, info, info.Length, info, info.Length, out ret, IntPtr.Zero)) {
          port.Speed = info[23];
          port.Connected = BitConverter.ToInt32(info, 31) == 1; // ConnectionStatus == DeviceConnected
        }
        result.Add(port);
      }
    }
    return result.ToArray();
  }
}
'@
}

# Device Manager's category names ("Sound, video and game controllers", ...) live in the class registry keys.
$classNames = @{}
function Get-ClassTitle([string]$guid, [string]$fallback) {
  if (-not $guid) { return $fallback }
  if (-not $classNames.ContainsKey($guid)) { $classNames[$guid] = [PorterDevProps]::ClassTitle($guid) }
  if ($classNames[$guid]) { return $classNames[$guid] }
  return $fallback
}

# Real monitor model names and the physical connector they use.
$monitors = @{}
try {
  foreach ($m in Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction Stop) {
    $id = ($m.InstanceName -replace '_\d+$', '').ToUpperInvariant()
    $monitors[$id] = @{ Model = (-join ($m.UserFriendlyName | Where-Object { $_ } | ForEach-Object { [char]$_ })) }
  }
  foreach ($c in Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams -ErrorAction Stop) {
    $id = ($c.InstanceName -replace '_\d+$', '').ToUpperInvariant()
    if (-not $monitors.ContainsKey($id)) { $monitors[$id] = @{} }
    $monitors[$id].Output = [int64]$c.VideoOutputTechnology
  }
} catch {}

$pnp = @(Get-PnpDevice)

# Every connected USB hub (root hubs and external hubs), port by port.
$ports = foreach ($hub in $pnp) {
  if ($hub.Present -and $hub.Class -eq 'USB' -and $hub.InstanceId -match '^USB\\') {
    try { [PorterHubs]::Ports($hub.InstanceId) } catch {}
  }
}

$out = foreach ($d in $pnp) {
  $info = [PorterDevProps]::Lookup($d.InstanceId)
  $name = $d.FriendlyName
  if (-not $name) { $name = $d.Name }
  $mon = $monitors[$d.InstanceId.ToUpperInvariant()]
  [pscustomobject]@{
    Name           = $name
    DeviceID       = $d.InstanceId
    Manufacturer   = $d.Manufacturer
    Present        = [bool]$d.Present
    Status         = [string]$d.Status
    ProblemCode    = [int]$d.ConfigManagerErrorCode
    Class          = $d.Class
    ClassTitle     = Get-ClassTitle ([string]$d.ClassGuid) $d.Class
    Enumerator     = $info.Enumerator
    HardwareId     = $info.HardwareId
    BusDescription = $info.BusDescription
    DriverVersion  = $info.DriverVersion
    DriverProvider = $info.DriverProvider
    DriverDate     = $info.DriverDate
    LocationPaths  = $info.LocationPaths
    LocationInfo   = $info.LocationInfo
    Parent         = $info.Parent
    MonitorModel   = if ($mon) { $mon.Model } else { $null }
    VideoOutput    = if ($mon -and $mon.ContainsKey('Output')) { $mon.Output } else { $null }
  }
}

ConvertTo-Json -InputObject ([pscustomobject]@{ Devices = @($out); Ports = @($ports) }) -Depth 5 -Compress
