// Fixture-only primitive investigation. Never imported by the product.
// This is deliberately not a recursive cleanup adapter or a qualified lane.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class CleanupIdentityPrototype {
  const uint ReadAttributes=0x80, Delete=0x10000, Backup=0x02000000, Reparse=0x00200000;
  static JavaScriptSerializer json=new JavaScriptSerializer();
  static List<object> trace=new List<object>();
  static string root, mode;
  [StructLayout(LayoutKind.Sequential)] struct FT { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public FT Creation,Access,Write;
    public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Id { public ulong Volume,Low,High; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Start {
    public uint cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show,reserved2; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated;
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime,jobTime; public uint flags; public UIntPtr min,max;
    public uint active; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Stream {
    public long size; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=296)] public string name;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int kind,out Id i,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,byte[] value,uint size);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr sa,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits limits,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting a,uint size,IntPtr length);
  [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryJobLimits(IntPtr job,int kind,out Limits a,uint size,IntPtr length);
  [DllImport("kernel32.dll",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryJobMembers(IntPtr job,int kind,IntPtr a,uint size,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint status);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string image,StringBuilder command,IntPtr psa,IntPtr tsa,bool inherit,uint flags,IntPtr env,string cwd,ref Start start,out ProcessInfo p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out FT creation,out FT exit,out FT kernel,out FT user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint status);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr p,IntPtr job,out bool result);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool MoveFileW(string from,string to);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstStreamW(string p,int level,out Stream stream,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextStreamW(IntPtr h,out Stream stream);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool FindClose(IntPtr h);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationW(string p,StringBuilder label,uint labelSize,out uint serial,out uint max,out uint flags,StringBuilder fs,uint fsSize);

  static Dictionary<string,object> D(params object[] pairs) { var d=new Dictionary<string,object>();for(int n=0;n<pairs.Length;n+=2)d.Add((string)pairs[n],pairs[n+1]);return d; }
  static void Event(string name,params object[] pairs) { var d=D(pairs);d.Add("event",name);d.Add("qpc",Stopwatch.GetTimestamp().ToString());trace.Add(d); }
  static void Check(bool ok,string operation) { if(!ok)throw new IOException(operation+" Win32="+Marshal.GetLastWin32Error()); }
  static string P(string relative) { return Path.Combine(root,relative); }
  static string Native(string p) { return p.StartsWith("\\\\?\\")?p:"\\\\?\\"+p; }
  static void Save(string name,object value) { File.WriteAllText(P(name),json.Serialize(value),new UTF8Encoding(false)); }
  static void ValidateRoot(string path) {
    root=Path.GetFullPath(path);
    string temporary=Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\')+"\\";
    if(!root.StartsWith(temporary,StringComparison.OrdinalIgnoreCase)||!Path.GetFileName(root).StartsWith("reclaim-cleanup-native-",StringComparison.Ordinal)||!File.Exists(P("fixture.marker")))throw new IOException("Not an owned fixture root");
    for(string p=root;p!=null;) { if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("Reparse fixture ancestor");string next=Path.GetDirectoryName(p);if(next==p)break;p=next; }
  }
  static string JobName() { return "Local\\ReclaimCleanupIdentity-"+Path.GetFileName(root); }
  static void RequireContained() { IntPtr job=OpenJobObjectW(4,false,JobName());Check(job!=IntPtr.Zero,"Open exact fixture Job");try{bool inside;Check(IsProcessInJob(GetCurrentProcess(),job,out inside)&&inside,"IsProcessInJob exact fixture");Event("membership-confirmed","pid",Process.GetCurrentProcess().Id,"job",JobName());}finally{CloseHandle(job);} }
  static Dictionary<string,object> Identity(SafeFileHandle h) {
    Info i;Id id;Check(GetFileInformationByHandle(h,out i),"GetFileInformationByHandle");
    Check(GetFileInformationByHandleEx(h,18,out id,(uint)Marshal.SizeOf(typeof(Id))),"FileIdInfo");
    return D("volume",id.Volume.ToString("x"),"fileId",id.High.ToString("x16")+id.Low.ToString("x16"),"legacyFileId",(((ulong)i.IndexHigh<<32)|i.IndexLow).ToString(),"attributes",i.Attributes,"links",i.Links,"size",(((ulong)i.SizeHigh<<32)|i.SizeLow).ToString(),"write",(((ulong)i.Write.High<<32)|i.Write.Low).ToString(),"creation",(((ulong)i.Creation.High<<32)|i.Creation.Low).ToString());
  }
  static SafeFileHandle Open(string p,uint access,uint share,bool directory) {
    SafeFileHandle h=CreateFileW(Native(p),access,share,IntPtr.Zero,3,Reparse|(directory?Backup:0),IntPtr.Zero);
    int nativeError=Marshal.GetLastWin32Error();Event("open","relative",p.StartsWith(root)?p.Substring(root.Length):"ancestor","access",access,"share",share,"success",!h.IsInvalid,"nativeError",h.IsInvalid?nativeError:0);
    if(h.IsInvalid){h.Dispose();throw new IOException("Open refused Win32="+nativeError);}
    Info info;Check(GetFileInformationByHandle(h,out info),"attributes");
    if((info.Attributes&0x441400)!=0){h.Dispose();throw new IOException("Unsafe file attributes");}
    return h;
  }
  static void Retain(List<SafeFileHandle> handles,SafeFileHandle handle) {
    if(handles.Count>=512){handle.Dispose();throw new IOException("Retained object handle limit");}handles.Add(handle);
  }
  static bool HasAlternateStream(string file) {
    Stream stream;IntPtr find=FindFirstStreamW(Native(file),0,out stream,0);
    if(find==new IntPtr(-1))throw new IOException("Stream enumeration unavailable Win32="+Marshal.GetLastWin32Error());
    try { do { Event("stream","name",stream.name);if(stream.name!="::$DATA")return true; }while(FindNextStreamW(find,out stream));
      if(Marshal.GetLastWin32Error()!=38)throw new IOException("Stream enumeration incomplete");
    }finally{FindClose(find);}return false;
  }
  static ProcessInfo Spawn(string role,IntPtr job) {
    string exe=Process.GetCurrentProcess().MainModule.FileName;
    Start start=new Start();start.cb=(uint)Marshal.SizeOf(typeof(Start));ProcessInfo child;
    var command=new StringBuilder("\""+exe+"\" "+role+" \""+root+"\" "+mode);
    Check(CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,root,ref start,out child),"CreateProcess suspended");
    bool resumed=false;
    try {
      if(job!=IntPtr.Zero)Check(AssignProcessToJobObject(job,child.process),"AssignProcessToJobObject");
      bool contained;Check(IsProcessInJob(child.process,job,out contained)&&contained,"Verify child membership");
      FT creation,exit,kernel,user;Check(GetProcessTimes(child.process,out creation,out exit,out kernel,out user),"GetProcessTimes");
      Event("child-contained-suspended","role",role,"pid",child.pid,"creation",(((ulong)creation.High<<32)|creation.Low).ToString());
      Check(ResumeThread(child.thread)!=0xffffffff,"ResumeThread");resumed=true;return child;
    }finally{CloseHandle(child.thread);if(!resumed){TerminateProcess(child.process,98);while(WaitForSingleObject(child.process,100)!=0)Thread.Sleep(10);CloseHandle(child.process);}}
  }
  static void AwaitMarker(string name) { var timer=Stopwatch.StartNew();while(!File.Exists(P(name))){if(timer.ElapsedMilliseconds>5000)throw new IOException("Barrier timeout "+name);Thread.Sleep(5);} }
  static string[] MemberIds(IntPtr job) {
    int bytes=8+IntPtr.Size*512;IntPtr buffer=Marshal.AllocHGlobal(bytes);
    try {
      Check(QueryJobMembers(job,3,buffer,(uint)bytes,IntPtr.Zero),"Job member list");
      int assigned=Marshal.ReadInt32(buffer,0),count=Marshal.ReadInt32(buffer,4);
      if(count<0||count>512||assigned!=count)throw new IOException("Incomplete Job member snapshot");
      var members=new string[count];for(int n=0;n<count;n++)members[n]=Marshal.ReadInt64(buffer,8+n*IntPtr.Size).ToString();Array.Sort(members,StringComparer.Ordinal);return members;
    }finally{Marshal.FreeHGlobal(buffer);}
  }
  static int Actor() {
    RequireContained();string payload=P("project\\dist\\payload");
    SafeFileHandle conflict=null;bool success=false;int nativeError=0;
    try {
      if(mode=="conflicting-handle") { conflict=CreateFileW(Native(payload),0x40000000,7,IntPtr.Zero,3,Reparse,IntPtr.Zero);nativeError=Marshal.GetLastWin32Error();success=!conflict.IsInvalid;Save("actor-ready",D("success",success));AwaitMarker("actor-release"); }
      else {
        AwaitMarker("actor-go");
        if(mode=="target-rename")success=MoveFileW(Native(P("project\\dist")),Native(P("project\\renamed-dist")));
        else if(mode=="ancestor-rename")success=MoveFileW(Native(P("project")),Native(P("renamed-project")));
        else if(mode=="changed-descendant") { using(var h=CreateFileW(Native(payload),0x40000000,7,IntPtr.Zero,3,Reparse,IntPtr.Zero)){nativeError=Marshal.GetLastWin32Error();success=!h.IsInvalid;} }
        else if(mode=="late-created-descendant") { using(var h=CreateFileW(Native(P("project\\dist\\late")),0x40000000,7,IntPtr.Zero,1,Reparse,IntPtr.Zero)){nativeError=Marshal.GetLastWin32Error();success=!h.IsInvalid;} }
        if(mode=="target-rename"||mode=="ancestor-rename")nativeError=success?0:Marshal.GetLastWin32Error();
      }
      Event("actor-result","success",success,"nativeError",nativeError);
      Save("actor.json",D("mode",mode,"success",success,"nativeError",nativeError,"trace",trace));return 0;
    } finally { if(conflict!=null)conflict.Dispose(); }
  }
  static int Worker() {
    RequireContained();var retained=new List<SafeFileHandle>();ProcessInfo actor=new ProcessInfo();bool hasActor=false;
    string status="refused";int deleted=0;string reason="";
    try {
      if(mode=="conflicting-handle"){actor=Spawn("actor",IntPtr.Zero);hasActor=true;AwaitMarker("actor-ready");}
      var parents=new List<string>();for(string p=P("project");p!=null;){parents.Add(p);string next=Path.GetDirectoryName(p);if(next==p)break;p=next;}parents.Reverse();
      foreach(string parent in parents){if(retained.Count>=510)throw new IOException("Retained object handle limit reserves target and leaf");var parentHandle=Open(parent,ReadAttributes,3,true);Retain(retained,parentHandle);Event("retained-ancestor","identity",Identity(parentHandle));}
      SafeFileHandle directory=Open(P("project\\dist"),Delete|ReadAttributes,3,true);Retain(retained,directory);
      SafeFileHandle file=Open(P("project\\dist\\payload"),Delete|ReadAttributes,1,false);Retain(retained,file);
      var identity=Identity(file);Event("retained-entry-identity","identity",identity,"directory",Identity(directory),"retainedHandles",retained.Count);
      var expected=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(P("expected.json")));
      if((string)expected["ino"]!=(string)identity["legacyFileId"])throw new IOException("Prepared identity mismatch");
      if(Convert.ToUInt32(identity["links"])!=1)throw new IOException("Multiple links refused");
      if(HasAlternateStream(P("project\\dist\\payload")))throw new IOException("Alternate stream refused");
      if(mode=="target-rename"||mode=="ancestor-rename"||mode=="changed-descendant"||mode=="late-created-descendant") {
        actor=Spawn("actor",IntPtr.Zero);hasActor=true;Save("actor-go",D("ready",true));
        Check(WaitForSingleObject(actor.process,5000)==0,"Actor exit barrier");
        Event("actor-exit-observed");
      }
      Save("worker-ready",D("ready",true));
      if(mode=="cancel") { AwaitMarker("cancel");status="interrupted";throw new OperationCanceledException("Cancellation before disposition"); }
      if(mode=="blocked-cancel") {
        // Deliberately non-cooperative admitted work: this is a negative fixture,
        // not a successful cancellation strategy. A missed deadline invalidates it.
        Save("worker.json",D("status","started","deletedFiles",0,"trace",trace));
        AwaitMarker("cancel");Event("cancel-observed-but-drain-blocked");
        Save("worker.json",D("status","interrupted","deletedFiles",null,"uncertainty","Worker retains authority and has not drained","trace",trace));
        Thread.Sleep(Timeout.Infinite);
      }
      if(mode=="helper-failure"){Event("fault-before-disposition");Save("worker.json",D("status","interrupted","deletedFiles",0,"trace",trace,"reason","Injected helper process exit"));return 7;}
      var final=Identity(file);if(json.Serialize(final)!=json.Serialize(identity))throw new IOException("Retained metadata changed");
      Event("before-file-disposition");Check(SetFileInformationByHandle(file,4,new byte[]{1},1),"File disposition");file.Dispose();deleted=1;status="partial";Event("after-file-disposition");
      Event("before-directory-removal");Check(SetFileInformationByHandle(directory,4,new byte[]{1},1),"Directory disposition");directory.Dispose();status="complete";Event("after-directory-removal");
    }catch(Exception e){reason=e.Message;Event("operation-settled","status",status,"reason",reason);}
    finally {
      if(hasActor){Save("actor-release",D("release",true));if(WaitForSingleObject(actor.process,5000)!=0)throw new IOException("Actor drain not proven");CloseHandle(actor.process);}
      for(int n=retained.Count-1;n>=0;n--)retained[n].Dispose();
    }
    Save("worker.json",D("mode",mode,"status",status,"deletedFiles",deleted,"reason",reason,"trace",trace));return 0;
  }
  static int Supervisor() {
    uint serial,max,flags;var fs=new StringBuilder(100);Check(GetVolumeInformationW(Path.GetPathRoot(root),null,0,out serial,out max,out flags,fs,100),"Volume");
    if(!String.Equals(fs.ToString(),"NTFS",StringComparison.OrdinalIgnoreCase))throw new IOException("Unsupported fixture filesystem; no mutator launched");
    IntPtr job=CreateJobObjectW(IntPtr.Zero,JobName());int createError=Marshal.GetLastWin32Error();Check(job!=IntPtr.Zero,"CreateJob");
    // Opening an existing named container grants no authority to alter or kill it.
    // Close only this new reference; no limits, child, or termination operation.
    if(createError==183){CloseHandle(job);Event("existing-job-refused","nativeError",createError);Save("collision-refusal.json",D("containerOwned",false,"workerSpawned",false,"operationStatus","refused","reason","Named Job already exists","nativeError",createError,"trace",trace));return 4;}
    var limits=new Limits();limits.basic.flags=0x2000;Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))),"Kill on close Job");
    ProcessInfo worker=new ProcessInfo();bool exited=false,zero=false,watchdog=false;uint code=0;long stopAt=0;
    try {
      worker=Spawn("worker",job);var timer=Stopwatch.StartNew();
      while(true) {
        uint wait=WaitForSingleObject(worker.process,10);Check(wait==0||wait==258,"Wait original process handle");exited=wait==0;
        Accounting accounting;Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"Job accounting");zero=accounting.active==0;
        long now=Stopwatch.GetTimestamp();
        bool cancelReady=(mode=="cancel"||mode=="blocked-cancel")&&File.Exists(P("worker-ready"));
        if(stopAt==0&&(!zero||!exited)&&(cancelReady||timer.ElapsedMilliseconds>=60000||exited)) {
          stopAt=now;Event("stop-requested","reason",cancelReady?"explicit-cancel":exited?"primary-exit":"operation-budget","deadlineQpc",(stopAt+5*Stopwatch.Frequency).ToString());
          Save("cancel",D("cancel",true,"requestedQpc",stopAt.ToString()));
        }
        if(stopAt!=0&&now-stopAt>=5*Stopwatch.Frequency&&!watchdog) {
          watchdog=true;Event("drain-watchdog-missed","elapsedMilliseconds",(now-stopAt)*1000/Stopwatch.Frequency);
          Save("supervisor-pending.json",D("strategyVerdict","Invalidated","operationReceipt",D("status","interrupted","deletedFiles",null,"uncertainty","Drain deadline missed; old authority not yet proven ended"),"primaryExited",exited,"jobActive",accounting.active,"trace",trace));
          if(!zero)Check(TerminateJobObject(job,99),"Terminate only owned Job");
          Event("owned-job-termination-requested");
        }
        // Both observations are mandatory, even following forced termination.
        if(exited&&zero)break;
      }
      Check(exited&&zero,"Strict drain");Check(GetExitCodeProcess(worker.process,out code),"GetExitCode");Event("strict-drain","primaryExited",exited,"jobActive",0,"exitCode",code);
      Save("supervisor.json",D("mode",mode,"containerOwned",true,"primaryExited",exited,"jobActive",0,"watchdogMissed",watchdog,"workerExitCode",code,"strategyVerdict",watchdog?"Invalidated":"Partial","operationReceipt",D("status",watchdog?"interrupted":"see-worker","deletedFiles",null,"uncertainty",watchdog?"Cancellation drain deadline missed; no automatic retry; inspect actual files":"Primitive result only; not a qualified lane"),"volumeSerial",serial.ToString("x"),"fileSystem",fs.ToString(),"osVersion",Environment.OSVersion.Version.ToString(),"architecture",Environment.Is64BitProcess?"x64":"x86","qpcFrequency",Stopwatch.Frequency.ToString(),"stopRequestedQpc",stopAt==0?null:stopAt.ToString(),"drainObservedQpc",Stopwatch.GetTimestamp().ToString(),"trace",trace));return watchdog?2:0;
    }finally {
      // Never release the owned Job/creation handle before independent exit proof.
      if(!exited||!zero) { while(true){Accounting a;bool primaryTerminal=worker.process==IntPtr.Zero||WaitForSingleObject(worker.process,0)==0;if(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)&&a.active==0&&primaryTerminal)break;TerminateJobObject(job,99);Thread.Sleep(100);} }
      Save("supervisor-finally-drain.json",D("originalWorkerExited",worker.process==IntPtr.Zero||WaitForSingleObject(worker.process,0)==0,"jobActive",0,"workerWasCreated",worker.process!=IntPtr.Zero,"trace",trace));
      if(worker.process!=IntPtr.Zero)CloseHandle(worker.process);CloseHandle(job);
    }
  }
  static int Collision() {
    // This fixture alone owns the deliberately pre-existing container and member.
    IntPtr job=CreateJobObjectW(IntPtr.Zero,JobName());int createError=Marshal.GetLastWin32Error();Check(job!=IntPtr.Zero,"Collision fixture CreateJob");
    if(createError==183){CloseHandle(job);throw new IOException("Collision fixture could not establish new ownership");}
    var original=new Limits();original.basic.flags=0x2008;original.basic.active=2;
    Check(SetInformationJobObject(job,9,ref original,(uint)Marshal.SizeOf(typeof(Limits))),"Collision fixture limits");
    ProcessInfo member=new ProcessInfo();bool exited=false,zero=false;
    try {
      member=Spawn("collision-member",job);AwaitMarker("collision-member-ready");
      Limits before;Check(QueryJobLimits(job,9,out before,(uint)Marshal.SizeOf(typeof(Limits)),IntPtr.Zero),"Collision before limits");
      Accounting beforeMembers;Check(QueryInformationJobObject(job,1,out beforeMembers,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"Collision before accounting");
      string[] beforeIds=MemberIds(job);
      int refused=Supervisor();
      Limits after;Check(QueryJobLimits(job,9,out after,(uint)Marshal.SizeOf(typeof(Limits)),IntPtr.Zero),"Collision after limits");
      Accounting active;Check(QueryInformationJobObject(job,1,out active,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"Collision accounting");
      string[] afterIds=MemberIds(job);
      bool memberAlive=WaitForSingleObject(member.process,0)==258;
      Event("collision-observation","refusedExitCode",refused,"beforeFlags",before.basic.flags,"afterFlags",after.basic.flags,"beforeActiveLimit",before.basic.active,"afterActiveLimit",after.basic.active,"beforeActiveMembers",beforeMembers.active,"afterActiveMembers",active.active,"beforeMemberIds",beforeIds,"afterMemberIds",afterIds,"originalMemberAlive",memberAlive);
      Save("collision-observation.json",D("trace",trace));
      Check(refused==4&&before.basic.flags==after.basic.flags&&before.basic.active==after.basic.active&&active.active==beforeMembers.active&&String.Join(",",beforeIds)==String.Join(",",afterIds)&&memberAlive,"Existing container unchanged");
      Event("collision-container-unchanged","beforeFlags",before.basic.flags,"afterFlags",after.basic.flags,"beforeActiveLimit",before.basic.active,"afterActiveLimit",after.basic.active,"activeMembers",active.active,"originalMemberAlive",memberAlive);
      Save("collision-release",D("release",true));Check(WaitForSingleObject(member.process,5000)==0,"Collision member exit");exited=true;
      Accounting drained;Check(QueryInformationJobObject(job,1,out drained,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"Collision strict drain");zero=drained.active==0;Check(zero,"Collision members zero");
      Save("supervisor.json",D("mode",mode,"collisionRefused",true,"existingContainerUnchanged",true,"originalMemberAliveAfterRefusal",memberAlive,"containerOwnedByCollisionFixture",true,"primaryExited",exited,"jobActive",0,"watchdogMissed",false,"strategyVerdict","Partial","operationReceipt",D("status","refused","deletedFiles",0),"trace",trace));return 0;
    }finally {
      if(!exited||!zero){Save("collision-release",D("release",true));TerminateJobObject(job,99);while(true){Accounting a;bool terminal=member.process==IntPtr.Zero||WaitForSingleObject(member.process,100)==0;if(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)&&a.active==0&&terminal)break;Thread.Sleep(10);}}
      Save("collision-drain.json",D("originalMemberExited",member.process==IntPtr.Zero||WaitForSingleObject(member.process,0)==0,"jobActive",0,"trace",trace));
      if(member.process!=IntPtr.Zero)CloseHandle(member.process);CloseHandle(job);
    }
  }
  public static int Main(string[] args) {
    try {
      if(args.Length!=3)throw new IOException("Fixed fixture invocation required");
      ValidateRoot(args[1]);mode=args[2];
      string[] allowed={"ordinary","target-rename","ancestor-rename","changed-descendant","late-created-descendant","hardlink","alternate-stream","conflicting-handle","cancel","helper-failure","unicode","blocked-cancel","job-collision"};
      if(Array.IndexOf(allowed,mode)<0)throw new IOException("Unsupported fixture case");
      if(args[0]=="supervisor")return Supervisor();if(args[0]=="worker")return Worker();if(args[0]=="actor")return Actor();if(args[0]=="collision")return Collision();if(args[0]=="collision-member"){RequireContained();Save("collision-member-ready",D("ready",true));while(!File.Exists(P("collision-release")))Thread.Sleep(5);return 0;}throw new IOException("Unsupported fixture role");
    }catch(Exception e){try{Save("error-"+Process.GetCurrentProcess().Id+".json",D("error",e.Message,"trace",trace));}catch{}return 3;}
  }
}
