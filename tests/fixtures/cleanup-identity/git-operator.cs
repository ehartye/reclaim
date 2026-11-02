// Synthetic registered-worktree operator experiment; no product imports.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static partial class CleanupGitPrototype {
  [StructLayout(LayoutKind.Sequential)] struct Security { public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit; }
  [StructLayout(LayoutKind.Sequential)] struct StartEx { public Start start;public IntPtr attributes; }
  [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateInheritedFile(string p,uint access,uint share,ref Security sa,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",EntryPoint="CreateProcessW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateGitProcess(string image,StringBuilder command,IntPtr psa,IntPtr tsa,bool inherit,uint flags,IntPtr env,string cwd,ref StartEx start,out ProcessInfo p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr bytes);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr bytes,IntPtr previous,IntPtr length);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle file,byte[] buffer,uint length,out uint read,IntPtr overlapped);
  static List<object> gitRuns=new List<object>();
  static long firstStopRequest=0;
  static string Scenario() { string value=File.Exists(P("scenario.txt"))?File.ReadAllText(P("scenario.txt")).Trim():"ordinary";if(value!="ordinary"&&value!="observer-cancel"&&value!="descendant-survival")throw new IOException("Unsupported fixed Git scenario");return value; }
  static void RequestStop(string reason) {
    if(firstStopRequest!=0)return;
    firstStopRequest=Stopwatch.GetTimestamp();
    Event("internal-stop-requested","reason",reason,"requestedQpc",firstStopRequest.ToString());
    Save("stop-request.json",D("reason",reason,"requestedQpc",firstStopRequest.ToString()));
    File.WriteAllText(P("stop-request-ready"),"closed stop receipt",new UTF8Encoding(false));
    File.WriteAllText(P("cancel"),"stop admissions",new UTF8Encoding(false));
  }
  static long PublishedStopQpc(long operationStart,long now) {
    if(!File.Exists(P("stop-request-ready")))return 0;
    var request=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(P("stop-request.json")));long qpc;
    if(!Int64.TryParse((string)request["requestedQpc"],out qpc)||qpc<operationStart||qpc>now)throw new IOException("Invalid shared stop timestamp");return qpc;
  }
  static void AwaitAdmittedProcess(IntPtr process,int budgetMilliseconds,string label) {
    var timer=Stopwatch.StartNew();
    while(WaitForSingleObject(process,10)==258) {
      if(File.Exists(P("cancel"))){RequestStop("cancel:"+label);throw new OperationCanceledException("Git cancellation: "+label);}
      if(timer.ElapsedMilliseconds>=budgetMilliseconds){RequestStop("command-budget:"+label);throw new OperationCanceledException("Git command budget: "+label);}
    }
    Check(WaitForSingleObject(process,0)==0,"Admitted original process exit");
  }
  static string GitPath() { string p=File.ReadAllText(P("git-path.txt")).Trim();if(!Path.IsPathRooted(p)||!String.Equals(Path.GetFileName(p),"git.exe",StringComparison.OrdinalIgnoreCase)||!File.Exists(p))throw new IOException("Expected existing native Git executable");return p; }
  static string Arg(string s) { if(s.IndexOf('"')>=0||s.EndsWith("\\",StringComparison.Ordinal))throw new IOException("Unsupported fixture argument");return "\""+s+"\""; }
  static IntPtr GitEnvironment() {
    var env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    foreach(string name in new string[]{"SystemRoot","WINDIR","ComSpec"}){string value=Environment.GetEnvironmentVariable(name);if(!String.IsNullOrEmpty(value))env[name]=value;}
    env["PATH"]=Path.GetDirectoryName(GitPath())+";"+Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"),"System32");
    env["HOME"]=P("neutral-home");env["USERPROFILE"]=P("neutral-home");env["APPDATA"]=P("neutral-home\\appdata");env["XDG_CONFIG_HOME"]=P("neutral-home\\config");env["TEMP"]=P("neutral-temp");env["TMP"]=P("neutral-temp");
    env["GIT_CONFIG_NOSYSTEM"]="1";env["GIT_CONFIG_SYSTEM"]="NUL";env["GIT_CONFIG_GLOBAL"]="NUL";env["GIT_CONFIG_COUNT"]="0";env["GIT_ATTR_NOSYSTEM"]="1";env["GIT_TERMINAL_PROMPT"]="0";env["GIT_OPTIONAL_LOCKS"]="0";env["LC_ALL"]="C";
    var block=new StringBuilder();foreach(var pair in env)block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');block.Append('\0');return Marshal.StringToHGlobalUni(block.ToString());
  }
  static string Git(string label,string cwd,bool allowFailure,params string[] args) {
    if(File.Exists(P("cancel")))throw new OperationCanceledException("Git admission stopped before "+label);
    Event("git-admitted","label",label);
    string stdout=P("git-"+label+".stdout"),stderr=P("git-"+label+".stderr");
    var security=new Security();security.length=Marshal.SizeOf(typeof(Security));security.inherit=true;
    using(var output=CreateInheritedFile(stdout,0x40000000,3,ref security,2,0x80,IntPtr.Zero))
    using(var errors=CreateInheritedFile(stderr,0x40000000,3,ref security,2,0x80,IntPtr.Zero))
    using(var input=CreateInheritedFile("NUL",0x80000000,7,ref security,3,0x80,IntPtr.Zero)) {
      Check(!output.IsInvalid&&!errors.IsInvalid&&!input.IsInvalid,"Git redirected handles");
      IntPtr attributeBytes=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attributeBytes);
      IntPtr list=Marshal.AllocHGlobal(attributeBytes),handles=Marshal.AllocHGlobal(IntPtr.Size*3),env=GitEnvironment();
      ProcessInfo child=new ProcessInfo();bool created=false,exited=false,initialized=false;uint exitCode=0;
      try {
        Check(InitializeProcThreadAttributeList(list,1,0,ref attributeBytes),"Initialize Git handle list");initialized=true;
        Marshal.WriteIntPtr(handles,0,input.DangerousGetHandle());Marshal.WriteIntPtr(handles,IntPtr.Size,output.DangerousGetHandle());Marshal.WriteIntPtr(handles,IntPtr.Size*2,errors.DangerousGetHandle());
        Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"Explicit Git inherited handles");
        var start=new StartEx();start.start.cb=(uint)Marshal.SizeOf(typeof(StartEx));start.start.flags=0x100;start.start.input=input.DangerousGetHandle();start.start.output=output.DangerousGetHandle();start.start.error=errors.DangerousGetHandle();start.attributes=list;
        var actual=new List<string>();actual.Add("--no-pager");
        foreach(string setting in new string[]{"core.hooksPath="+P("empty-hooks"),"core.autocrlf=false","core.fsmonitor=false","core.untrackedCache=false","commit.gpgSign=false","tag.gpgSign=false","user.name=Fixture","user.email=fixture@example.invalid","init.defaultBranch=fixture-main"}){actual.Add("-c");actual.Add(setting);}actual.AddRange(args);
        var command=new StringBuilder(Arg(GitPath()));foreach(string arg in actual)command.Append(' ').Append(Arg(arg));
        Check(CreateGitProcess(GitPath(),command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,cwd,ref start,out child),"Create contained Git suspended");created=true;
        IntPtr job=OpenJobObjectW(4,false,JobName());Check(job!=IntPtr.Zero,"Open owning Git fixture Job");
        try{bool inside;Check(IsProcessInJob(child.process,job,out inside)&&inside,"Exact Git Job membership before resume");}finally{CloseHandle(job);}
        FT creation,exit,kernel,user;Check(GetProcessTimes(child.process,out creation,out exit,out kernel,out user),"Git process creation identity");
        Event("git-contained-suspended","label",label,"pid",child.pid,"creation",(((ulong)creation.High<<32)|creation.Low).ToString(),"args",args,"inheritedHandles","stdin-NUL,stdout,stderr only");
        if(File.Exists(P("cancel")))throw new OperationCanceledException("Git cancelled before suspended child resume: "+label);
        Check(ResumeThread(child.thread)!=0xffffffff,"Resume contained Git");CloseHandle(child.thread);child.thread=IntPtr.Zero;
        AwaitAdmittedProcess(child.process,20000,label);
        Check(WaitForSingleObject(child.process,0)==0,"Original Git exit");exited=true;Check(GetExitCodeProcess(child.process,out exitCode),"Git exit code");
      }finally {
        if(created&&!exited){RequestStop("git-command-unsettled:"+label);TerminateProcess(child.process,97);while(WaitForSingleObject(child.process,100)!=0)Thread.Sleep(10);}
        if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);if(child.process!=IntPtr.Zero)CloseHandle(child.process);
        if(initialized)DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);Marshal.FreeHGlobal(handles);Marshal.FreeHGlobal(env);
      }
      output.Dispose();errors.Dispose();input.Dispose();
      string outText=File.ReadAllText(stdout),errorText=File.ReadAllText(stderr);
      if(outText.Length>128000||errorText.Length>128000)throw new IOException("Fixed Git fixture output exceeded bound");
      gitRuns.Add(D("label",label,"args",args,"exitCode",exitCode,"stdout",outText,"stderr",errorText));Save("git-runs.json",gitRuns);
      if(exitCode!=0&&!allowFailure)throw new IOException("Git fixture setup refused: "+label+" exit="+exitCode);
      return outText;
    }
  }
  static string Hash(SafeFileHandle file) {
    using(var data=new MemoryStream()) {
      byte[] bytes=new byte[4096];uint read;
      while(true){Check(ReadFile(file,bytes,(uint)bytes.Length,out read,IntPtr.Zero),"Read retained fixture file");if(read==0)break;data.Write(bytes,0,(int)read);if(data.Length>128000)throw new IOException("Fixed fixture file exceeds bound");}
      using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(data.ToArray())).Replace("-","").ToLowerInvariant();
    }
  }
  static int FixtureLauncher() {
    RequireContained();ProcessInfo child=Spawn("fixture-descendant",IntPtr.Zero);
    try { AwaitMarker("descendant-ready");Save("launcher.json",D("descendantPid",child.pid,"trace",trace));File.WriteAllText(P("launcher-ready"),"child alive");Thread.Sleep(Timeout.Infinite);return 0; }
    finally { CloseHandle(child.process); }
  }
  static int FixtureDescendant() {
    RequireContained();File.WriteAllText(P("descendant-ready"),"owned actor alive");
    while(!File.Exists(P("probe-after-worker-exit")))Thread.Sleep(5);
    using(var probe=CreateFileW(Native(P("selected-worktree")),Delete,7,IntPtr.Zero,3,Backup|Reparse,IntPtr.Zero)) {
      int error=Marshal.GetLastWin32Error();Event("descendant-delete-open-probe","success",!probe.IsInvalid,"nativeError",probe.IsInvalid?error:0);
      Save("descendant-probe.json",D("success",!probe.IsInvalid,"nativeError",probe.IsInvalid?error:0,"identity",probe.IsInvalid?null:Identity(probe),"trace",trace,"method","DELETE-access open only; no disposition, deletion or rename"));
      File.WriteAllText(P("descendant-probe-ready"),"closed probe receipt");
      // Negative fixture: remain admitted after stop. The owned supervisor must
      // invalidate the candidate and observe all exits; no further work follows.
      Thread.Sleep(Timeout.Infinite);
    }
    return 0;
  }
  static void ObserveSurvivalCounterexample(bool workerExited,uint active,ref bool breach) {
    if(Scenario()!="descendant-survival"||!workerExited||active==0||breach)return;
    if(!File.Exists(P("probe-after-worker-exit")))File.WriteAllText(P("probe-after-worker-exit"),"original worker handle signaled; owned members remain");
    if(!File.Exists(P("descendant-probe-ready")))return;
    var probe=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(P("descendant-probe.json")));
    if(Convert.ToBoolean(probe["success"])) {
      breach=true;Event("candidate-proof-lifetime-breach","originalWorkerExited",true,"jobActive",active);
      Save("candidate-invalidated.json",D("strategyVerdict","Invalidated","operationReceipt",D("status","interrupted","deletedFiles",null,"uncertainty","Required proof handles ended while an admitted descendant remained capable of delete access"),"originalWorkerExited",true,"jobActive",active,"probe",probe,"trace",trace));
    }
  }
  static void SurvivingDescendantSchedule() {
    ProcessInfo launcher=Spawn("fixture-launcher",IntPtr.Zero);bool exited=false;
    try { AwaitMarker("launcher-ready");AwaitAdmittedProcess(launcher.process,200,"injected-descendant-survival");exited=true; }
    finally { if(!exited){RequestStop("injected-launcher-unsettled");TerminateProcess(launcher.process,96);while(WaitForSingleObject(launcher.process,100)!=0)Thread.Sleep(10);}CloseHandle(launcher.process); }
  }
  static int Worker() {
    RequireContained();var retained=new List<SafeFileHandle>();string status="refused",reason="";object prepared=null;
    try {
      foreach(string relative in new string[]{"empty-hooks","neutral-home","neutral-temp","repo"})Directory.CreateDirectory(P(relative));
      Git("init",root,false,"init","repo");
      File.WriteAllText(P("repo\\README.md"),"synthetic tracked source\n",new UTF8Encoding(false));
      File.WriteAllText(P("repo\\package.json"),"{\"scripts\":{\"build\":\"fixture-only\"}}\n",new UTF8Encoding(false));
      File.WriteAllText(P("repo\\.gitignore"),"dist/\n*.local\n",new UTF8Encoding(false));
      Git("add",P("repo"),false,"add","README.md","package.json",".gitignore");Git("commit",P("repo"),false,"commit","-m","fixture");
      Git("preserving-ref",P("repo"),false,"update-ref","refs/heads/fixture-preserving-ref","HEAD");
      Git("worktree-add",P("repo"),false,"worktree","add","-b","fixture-preserved",P("selected-worktree"),"HEAD");
      Directory.CreateDirectory(P("repo\\dist"));File.WriteAllText(P("repo\\dist\\output.bin"),"unselected generated fixture\n",new UTF8Encoding(false));File.WriteAllText(P("repo\\private.local"),"unselected unknown ignored fixture\n",new UTF8Encoding(false));
      string ignored=Git("unselected-ignored",P("repo"),false,"status","--porcelain=v1","--ignored");
      string provenance=Git("unselected-ignore-rules",P("repo"),false,"check-ignore","--verbose","dist/output.bin","private.local");
      string clean=Git("selected-status-before",P("selected-worktree"),false,"status","--porcelain=v1","--untracked-files=all");
      if(clean.Trim().Length!=0)throw new IOException("Selected worktree is not clean; no compatibility conclusion");
      string refsBefore=Git("refs-before",P("repo"),false,"show-ref","--heads"),registrationBefore=Git("registration-before",P("repo"),false,"worktree","list","--porcelain");
      var parents=new List<string>();for(string p=root;p!=null;){parents.Add(p);string next=Path.GetDirectoryName(p);if(next==p)break;p=next;}parents.Reverse();
      foreach(string parent in parents){if(retained.Count>=505)throw new IOException("Git retained-handle limit");Retain(retained,Open(parent,ReadAttributes,3,true));}
      var target=Open(P("selected-worktree"),Delete|ReadAttributes,3,true);Retain(retained,target);
      var entries=new List<object>();string[] files=Directory.GetFiles(P("selected-worktree"));Array.Sort(files,StringComparer.Ordinal);
      if(Directory.GetDirectories(P("selected-worktree")).Length!=0||files.Length!=4)throw new IOException("Unexpected clean-worktree fixture inventory");
      foreach(string file in files){var handle=Open(file,0x80000000|Delete|ReadAttributes,1,false);Retain(retained,handle);entries.Add(D("name",Path.GetFileName(file),"identity",Identity(handle),"sha256",Hash(handle)));}
      prepared=D("selectedStatusBefore",clean,"refsBefore",refsBefore,"registrationBefore",registrationBefore,"unselectedIgnored",ignored,"unselectedIgnoreRules",provenance,"targetIdentity",Identity(target),"entries",entries,"retainedObjectHandles",retained.Count,"contract","Keep every target/entry handle held through unforced Git removal; no force/path fallback");
      Save("prepared.json",prepared);
      File.WriteAllText(P("observer-ready"),"prepared receipt closed",new UTF8Encoding(false));
      var observer=Stopwatch.StartNew();while(!File.Exists(P("observer-continue"))) {
        if(File.Exists(P("cancel"))) {
          RequestStop("observer-cancel");
          if(Scenario()=="observer-cancel"){var acknowledge=Stopwatch.StartNew();while(!File.Exists(P("stop-acknowledged"))){if(acknowledge.ElapsedMilliseconds>6000)throw new IOException("Supervisor failed to acknowledge first stop");Thread.Sleep(5);}}
          throw new OperationCanceledException("Independent observer cancelled");
        }
        if(observer.ElapsedMilliseconds>20000){RequestStop("observer-budget");throw new OperationCanceledException("Independent observer barrier budget");}Thread.Sleep(5);
      }
      if(Scenario()=="descendant-survival"){SurvivingDescendantSchedule();throw new IOException("Negative descendant schedule unexpectedly returned without a stop");}
      using(var conflicting=CreateFileW(Native(P("selected-worktree")),Delete,7,IntPtr.Zero,3,Backup|Reparse,IntPtr.Zero)) {
        int nativeError=Marshal.GetLastWin32Error();Event("required-target-delete-open-probe","success",!conflicting.IsInvalid,"nativeError",conflicting.IsInvalid?nativeError:0);
        if(!conflicting.IsInvalid)throw new IOException("Required sharing protection did not block independent delete access");
      }
      Git("remove-with-required-handles",P("repo"),true,"worktree","remove",P("selected-worktree"));
      // Evidence only: these fixed read-only commands do not weaken/retry removal.
      string refsAfter=Git("refs-after",P("repo"),false,"show-ref","--heads"),registrationAfter=Git("registration-after",P("repo"),false,"worktree","list","--porcelain");
      Save("git-outcome.json",D("refsBefore",refsBefore,"refsAfter",refsAfter,"registrationBefore",registrationBefore,"registrationAfter",registrationAfter,"gitRuns",gitRuns,"trace",trace));
      status="observed";
    }catch(Exception e){RequestStop("worker-error");if(e is OperationCanceledException||File.Exists(P("cancel")))status="interrupted";reason=e.Message;Event("git-operation-settled","status",status,"reason",reason);}
    finally { for(int n=retained.Count-1;n>=0;n--)retained[n].Dispose(); }
    Save("worker.json",D("status",status,"reason",reason,"prepared",prepared,"gitRuns",gitRuns,"trace",trace));return status=="observed"?0:6;
  }
}
