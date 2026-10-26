using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class ReclaimFolderMeasurement {
  public string path;
  public string measuredAt;
  public string status = "complete";
  public long logicalBytes;
  public long? allocatedBytes = 0;
  public long? exclusiveAllocatedBytes = 0;
  public long? sharedAllocatedBytes = 0;
  public long fileCount;
  public long? newestActivityAt;
  public long skippedCount;
  public long errorCount;
  public string basis = "allocated";
  public List<string> notices = new List<string>();
  public void Notice(string text) { if (notices.Count < 32 && !notices.Contains(text)) notices.Add(text); }
  public void Activity(DateTime time) {
    if (time.Year <= 1601) { status="partial";Notice("Creation or activity timestamp is unavailable; the generated age cannot be verified.");return; }
    long ms = (long)(time.ToUniversalTime() - new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
    if (!newestActivityAt.HasValue || ms > newestActivityAt.Value) newestActivityAt = ms;
  }
  public void Progress() {
    Console.WriteLine("{\"type\":\"progress\",\"logicalBytes\":" + logicalBytes + ",\"allocatedBytes\":" + (allocatedBytes.HasValue ? allocatedBytes.Value.ToString() : "null") + ",\"exclusiveAllocatedBytes\":" + (exclusiveAllocatedBytes.HasValue ? exclusiveAllocatedBytes.Value.ToString() : "null") + ",\"sharedAllocatedBytes\":" + (sharedAllocatedBytes.HasValue ? sharedAllocatedBytes.Value.ToString() : "null") + ",\"fileCount\":" + fileCount + ",\"newestActivityAt\":" + (newestActivityAt.HasValue ? newestActivityAt.Value.ToString() : "null") + ",\"skippedCount\":" + skippedCount + ",\"errorCount\":" + errorCount + "}");
  }
}
public static class ReclaimFolderReader {
  const int Unsafe = 0x441400;
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct FileInfoNative {
    public uint Attributes; public FileTime Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileIdInfo { public ulong Volume, Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct StandardInfo {
    public long AllocationSize, EndOfFile;
    public uint NumberOfLinks;
    public byte DeletePending, Directory;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out FileInfoNative info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int kind,out FileIdInfo info,uint size);
  [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandleEx",SetLastError=true)] static extern bool GetStandardInfo(SafeFileHandle h,int kind,out StandardInfo info,uint size);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetCompressedFileSizeW(string p,out uint high);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationW(string root,StringBuilder label,uint labelSize,out uint serial,out uint maximum,out uint flags,StringBuilder fileSystem,uint fileSystemSize);
  static string Native(string p) { return p.StartsWith("\\\\?\\") ? p : "\\\\?\\" + p; }
  static bool Blocked(FileAttributes attributes) { return (((int)attributes) & Unsafe) != 0; }
  static void Ancestors(string p) {
    if(p.StartsWith("\\\\?\\"))p=p.Substring(4);
    for (string current=p; current!=null;) {
      if (Blocked(File.GetAttributes(Native(current)))) throw new IOException("Unsafe link, junction, offline or cloud ancestor: " + current);
      string next=Path.GetDirectoryName(current); if(next==current)break;current=next;
    }
  }
  static DateTime Date(FileTime time) { return DateTime.FromFileTimeUtc(((long)time.High<<32)|time.Low); }
  static void Unavailable(ReclaimFolderMeasurement r,string notice) {
    r.allocatedBytes=null;r.exclusiveAllocatedBytes=null;r.sharedAllocatedBytes=null;r.basis="logical-only";r.status="partial";r.Notice(notice);
  }
  public static ReclaimFolderMeasurement Measure(string raw,int timeoutMs) {
    ReclaimFolderMeasurement r=new ReclaimFolderMeasurement();r.path=Path.GetFullPath(raw);r.measuredAt=DateTime.UtcNow.ToString("o");
    r.Notice("Potential gain is an estimate of allocated default-stream data, not guaranteed free space. Directory metadata and alternate streams are not included.");
    r.Notice("Known shared hardlinks are excluded from exclusive potential gain, even if all their names happen to be inside this folder.");
    r.Notice("Activity is the newest observed creation or last-write time, not last use or an exact build/install date. Files may change while measuring.");
    Stopwatch timer=Stopwatch.StartNew();HashSet<string> seen=new HashSet<string>(StringComparer.Ordinal);
    try {
      if(r.path.Length<3 || r.path[1]!=':' || r.path[2]!='\\')throw new IOException("Only absolute local drive folder paths are supported.");
      Ancestors(r.path);
      if(!Directory.Exists(Native(r.path)))throw new DirectoryNotFoundException("Folder not found: " + r.path);
      uint serial,maximum,flags;StringBuilder fs=new StringBuilder(256);
      bool isNtfs=GetVolumeInformationW(Path.GetPathRoot(r.path),null,0,out serial,out maximum,out flags,fs,256)&&fs.ToString().Equals("NTFS",StringComparison.OrdinalIgnoreCase);
      Stack<string> directories=new Stack<string>();directories.Push(r.path);
      bool limit=false;
      while(directories.Count>0&&!limit) {
        if(timer.ElapsedMilliseconds>=timeoutMs){r.status="partial";r.Notice("Measurement time budget reached; totals and activity are incomplete.");break;}
        string dir=directories.Pop();
        try {
          Ancestors(dir);DirectoryInfo info=new DirectoryInfo(Native(dir));
          if(Blocked(info.Attributes)){r.skippedCount++;r.status="partial";r.Notice("Links, junctions, offline files and cloud objects were not followed.");continue;}
          r.Activity(info.CreationTimeUtc);r.Activity(info.LastWriteTimeUtc);
          foreach(FileSystemInfo entry in info.EnumerateFileSystemInfos()) {
            if(timer.ElapsedMilliseconds>=timeoutMs || r.fileCount>=2000000){r.status="partial";r.Notice("Measurement time or two-million-file budget reached; totals and activity are incomplete.");limit=true;break;}
            try {
              if(Blocked(entry.Attributes)){r.skippedCount++;r.status="partial";r.Notice("Links, junctions, offline files and cloud objects were not followed.");continue;}
              if((entry.Attributes&FileAttributes.Directory)!=0){directories.Push(entry.FullName);continue;}
              string p=entry.FullName;
              using(SafeFileHandle handle=CreateFileW(Native(p),0,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
                if(handle.IsInvalid)throw new IOException("File metadata handle could not be opened ("+Marshal.GetLastWin32Error()+").");
                FileInfoNative before;
                if(!GetFileInformationByHandle(handle,out before))throw new IOException("File metadata could not be read ("+Marshal.GetLastWin32Error()+").");
                if((((int)before.Attributes)&Unsafe)!=0){r.skippedCount++;r.status="partial";r.Notice("Links, junctions, offline files and cloud objects were not followed.");continue;}
                FileIdInfo id;string identity;
                if(GetFileInformationByHandleEx(handle,18,out id,(uint)Marshal.SizeOf(typeof(FileIdInfo)))) identity=id.Volume.ToString("x")+":"+id.High.ToString("x16")+id.Low.ToString("x16");
                else if(isNtfs && (before.IndexHigh!=0||before.IndexLow!=0)) identity=before.Volume.ToString("x")+":"+before.IndexHigh.ToString("x8")+before.IndexLow.ToString("x8");
                else {Unavailable(r,"A reliable filesystem identity was unavailable; allocated gain is not authoritative.");r.errorCount++;continue;}
                r.Activity(Date(before.Creation));r.Activity(Date(before.Write));
                if(!seen.Add(identity))continue;
                long length=((long)before.SizeHigh<<32)|before.SizeLow;
                // Recheck path attributes immediately before the path-based allocation API.
                if(Blocked(File.GetAttributes(Native(p)))){r.skippedCount++;r.status="partial";r.Notice("A file became a link, offline or cloud object while measuring.");continue;}
                long allocated;
                if((before.Attributes & (0x800|0x200))!=0) {
                  // Compression/sparse allocation needs actual stored data, rather than ordinary end-of-file size.
                  uint high;uint low=GetCompressedFileSizeW(Native(p),out high);int error=Marshal.GetLastWin32Error();
                  if(low==0xffffffff && error!=0){Unavailable(r,"Compressed or sparse allocated size could not be read for every file.");r.errorCount++;continue;}
                  allocated=((long)high<<32)|low;
                } else {
                  // GetCompressedFileSize returns logical length for ordinary files; query allocation on the metadata handle.
                  StandardInfo standard;
                  if(!GetStandardInfo(handle,1,out standard,(uint)Marshal.SizeOf(typeof(StandardInfo))) || standard.AllocationSize<0) {
                    Unavailable(r,"Ordinary file allocation could not be read; logical length is not used as a substitute.");r.errorCount++;continue;
                  }
                  if(standard.EndOfFile!=length || standard.NumberOfLinks!=before.Links || standard.DeletePending!=0 || standard.Directory!=0) {
                    r.errorCount++;r.status="partial";r.Notice("A file changed during allocation measurement; its unstable values were excluded.");continue;
                  }
                  allocated=standard.AllocationSize;
                }
                FileInfoNative after;
                if(!GetFileInformationByHandle(handle,out after)||after.IndexLow!=before.IndexLow||after.IndexHigh!=before.IndexHigh||after.SizeLow!=before.SizeLow||after.SizeHigh!=before.SizeHigh||after.Write.Low!=before.Write.Low||after.Write.High!=before.Write.High||after.Links!=before.Links||(after.Attributes&(0x800|0x200))!=(before.Attributes&(0x800|0x200))) {
                  r.errorCount++;r.status="partial";r.Notice("A file changed during measurement; its unstable values were excluded.");continue;
                }
                r.logicalBytes+=length;r.fileCount++;
                if(r.allocatedBytes.HasValue) {
                  r.allocatedBytes+=allocated;
                  if(before.Links==1)r.exclusiveAllocatedBytes+=allocated;
                  else if(before.Links>1)r.sharedAllocatedBytes+=allocated;
                  else {Unavailable(r,"A file link count was unavailable; exclusive gain is not authoritative.");r.errorCount++;}
                }
                if(r.fileCount%1000==0)r.Progress();
              }
            } catch(Exception ex){r.errorCount++;r.status="partial";r.Notice("File metadata inspection failed: "+ex.Message);}
          }
        }catch(Exception ex){r.errorCount++;r.status="partial";r.Notice("Directory metadata inspection failed: "+ex.Message);}
      }
    }catch(Exception ex){r.errorCount++;r.status="partial";r.Notice(ex.Message);}
    return r;
  }
}
