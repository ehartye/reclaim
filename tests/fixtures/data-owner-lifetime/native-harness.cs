// Private WP1 counterexample harness. No candidate ownership mechanism is here.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

public static class OwnerLifetimeHarness {
  static JavaScriptSerializer json = new JavaScriptSerializer();
  static string root, mode, role;
  static long stopAt;
  static string stopCause;
  static bool deadlineMissed, internalFailure, stopTimestampUncertain;
  static bool cancelRequired, terminateRequired, diagnosticFailure;
  static int cancelAttempts, terminationAttempts, terminationSuccesses;
  static string lastTerminationError, lastCancellationError;
  static IntPtr job;
  static List<Child> children = new List<Child>();
  class Child { public string role; public IntPtr handle; public uint pid; public string creation; public bool observed; public uint code; }
  [StructLayout(LayoutKind.Sequential)] struct FT { public uint low, high; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Start { public uint cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr sa,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int kind,ref Limits l,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int kind,out Accounting a,uint size,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string exe,StringBuilder command,IntPtr psa,IntPtr tsa,bool inherit,uint flags,IntPtr env,string cwd,ref Start start,out PI p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out FT creation,out FT exit,out FT kernel,out FT user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool result);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryPerformanceCounter(out long value);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryPerformanceFrequency(out long value);
  static long frequency;
  static long Now() { long value; Check(QueryPerformanceCounter(out value),"QPC"); return value; }
  static Dictionary<string,object> D(params object[] p) { var d=new Dictionary<string,object>();for(int i=0;i<p.Length;i+=2)d.Add((string)p[i],p[i+1]);return d; }
  static string P(string p) { return Path.Combine(root,p); }
  static string Name(string suffix) { return "Local\\ReclaimOwnerLifetime-"+Path.GetFileName(root)+"-"+suffix; }
  static void Save(string name,object value) {
    // Fixture-only deterministic faults; no disk fill, permissions, or owner paths.
    if(role=="supervisor"&&((mode=="uncertain-write-failure"&&name=="stop-uncertain.json")||(mode=="deadline-write-failure"&&name=="deadline-missed.json")))throw new IOException("Injected diagnostic write failure: "+name);
    File.WriteAllText(P(name),json.Serialize(value),new UTF8Encoding(false));
  }
  static void Diagnostic(Action write,string target) {
    try{write();}catch(Exception e){diagnosticFailure=true;internalFailure=true;
      // Independent best-effort fallback, deliberately bypassing Save injection.
      // Its own failure cannot block or consume any native action obligation.
      try{File.AppendAllText(P("diagnostic-fallback.jsonl"),json.Serialize(D("target",target,"error",e.Message,"qpc",Now().ToString(),"operationStatus","interrupted","strategyVerdict","Invalidated","timestampUncertain",stopTimestampUncertain,"firstStopQpc",stopAt==0?null:stopAt.ToString()))+"\n",new UTF8Encoding(false));}catch{}
    }
  }
  static void AttemptRequiredActions() {
    // No diagnostic writes on this path. Failed attempts remain obligations and
    // are retried every supervision tick until exact terminal drain is proven.
    if(cancelRequired){cancelAttempts++;try{using(var e=Barrier("cancel"))e.Set();cancelRequired=false;}catch(Exception e){internalFailure=true;lastCancellationError=e.Message;}}
    if(terminateRequired){terminationAttempts++;try{if(TerminateJobObject(job,99)){terminationSuccesses++;}else{internalFailure=true;lastTerminationError="TerminateJobObject Win32="+Marshal.GetLastWin32Error();}}catch(Exception e){internalFailure=true;lastTerminationError=e.Message;}}
  }
  static void Event(string name,params object[] p) { var d=D(p);d.Add("event",name);d.Add("qpc",Now().ToString());d.Add("role",role);d.Add("processPid",Process.GetCurrentProcess().Id);File.AppendAllText(P(role+".jsonl"),json.Serialize(d)+"\n",new UTF8Encoding(false)); }
  static void Check(bool ok,string message) { if(!ok)throw new IOException(message+" Win32="+Marshal.GetLastWin32Error()); }
  static EventWaitHandle Barrier(string name) { return EventWaitHandle.OpenExisting(Name(name)); }
  static void Signal(string name) { using(var e=Barrier(name))e.Set();Event("barrier-signaled","name",name); }
  static void Wait(string name) { using(var e=Barrier(name))if(!e.WaitOne(10000))throw new IOException("Actor barrier timeout "+name);Event("barrier-observed","name",name); }
  static string Creation(IntPtr handle) { FT c,e,k,u;Check(GetProcessTimes(handle,out c,out e,out k,out u),"Creation identity");return (((ulong)c.high<<32)|c.low).ToString(); }
  static void Validate(string value) {
    root=Path.GetFullPath(value);string temporary=Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\')+"\\";
    if(!root.StartsWith(temporary,StringComparison.OrdinalIgnoreCase)||!Path.GetFileName(root).StartsWith("reclaim-owner-lifetime-")||!File.Exists(P("fixture.marker")))throw new IOException("Disposable fixture required");
    for(string p=root;p!=null;){if((File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0)throw new IOException("Reparse fixture ancestor refused");string next=Path.GetDirectoryName(p);if(next==p)break;p=next;}
  }
  static void RequireContained() { IntPtr j=OpenJobObjectW(4,false,Name("job"));Check(j!=IntPtr.Zero,"Open exact Job");try{bool inside;Check(IsProcessInJob(GetCurrentProcess(),j,out inside)&&inside,"Exact Job membership");Event("membership-confirmed");}finally{CloseHandle(j);} }
  static Child Spawn(string childRole,string exe,string arguments) {
    Start start=new Start();start.cb=(uint)Marshal.SizeOf(typeof(Start));PI p;
    Check(CreateProcessW(exe,new StringBuilder("\""+exe+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,root,ref start,out p),"Create suspended");
    var child=new Child{role=childRole,handle=p.process,pid=p.pid};children.Add(child);
    try { Check(AssignProcessToJobObject(job,p.process),"Assign owned Job");bool inside;Check(IsProcessInJob(p.process,job,out inside)&&inside,"Verify membership before resume");child.creation=Creation(p.process);Event("child-contained-suspended","actor",childRole,"pid",p.pid,"creation",child.creation);Check(ResumeThread(p.thread)!=0xffffffff,"Resume contained child");return child; }
    catch { Stop("spawn-error",Now());Check(TerminateProcess(p.process,98),"Terminate own unresumed process");throw; }
    finally { CloseHandle(p.thread); }
  }
  static Child Spawn(string childRole) { string exe=Process.GetCurrentProcess().MainModule.FileName;return Spawn(childRole,exe,childRole+" \""+root+"\" "+mode); }
  static void Stop(string cause,long at) {
    if(stopTimestampUncertain&&cause!="durable-cancel-request")return; // Never manufacture a fresh deadline for an unknown earlier request.
    if(stopAt!=0&&at>=stopAt)return;bool earlier=stopAt!=0;stopAt=at;stopCause=cause;cancelRequired=true;
    try{Diagnostic(delegate{Event(earlier?"earlier-stop-observed":"first-stop","cause",cause,"requestedQpc",at.ToString(),"deadlineQpc",stopTimestampUncertain?null:(at+5*frequency).ToString());},"supervisor.jsonl");Diagnostic(delegate{Save("stop-pending.json",D("operationStatus","interrupted","strategyVerdict",mode=="helper-loss"||internalFailure?"Invalidated":"Partial","cause",cause,"requestedQpc",at.ToString(),"deadlineQpc",stopTimestampUncertain?null:(at+5*frequency).ToString(),"timestampUncertain",stopTimestampUncertain,"authorityEnded",false));},"stop-pending.json");}
    finally{AttemptRequiredActions();}
  }
  static uint Active() { Accounting a;Check(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"Exact Job accounting");return a.active; }
  static void UncertainStop(string file,string reason) {
    internalFailure=true;terminateRequired=true;cancelRequired=true;
    try {
      if(stopTimestampUncertain)return;stopTimestampUncertain=true;
      Diagnostic(delegate{Save("stop-uncertain.json",D("operationStatus","interrupted","strategyVerdict","Invalidated","timestampUncertain",true,"requestFile",Path.GetFileName(file),"reason",reason,"firstKnownStopQpc",stopAt==0?null:stopAt.ToString(),"observedQpc",Now().ToString(),"authorityEnded",false,"action","Immediate owned-Job termination; no new five-second deadline"));},"stop-uncertain.json");
      Diagnostic(delegate{Event("stop-timestamp-uncertain","requestFile",Path.GetFileName(file),"reason",reason);},"supervisor.jsonl");
    }finally{AttemptRequiredActions();}
  }
  static void ReadDurableStops(long started,long now) {
    // Receipts are authoritative; the event is only a wakeup hint. Scan before
    // handling actor exit AND before accepting drain, including absent signals.
    string[] files;
    try{files=Directory.GetFiles(root,"*-cancel-request.*");}catch(Exception e){UncertainStop(root,"Cannot enumerate stop evidence: "+e.Message);return;}
    long earliest=long.MaxValue;string earliestFile=null,uncertainFile=null,uncertainReason=null;
    foreach(string file in files) {
      try {
        if(!file.EndsWith("-cancel-request.json",StringComparison.Ordinal)){throw new IOException("Interrupted/uncommitted stop receipt");}
        var request=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file));object raw;
        long requested;
        if(request==null||!request.TryGetValue("requestedQpc",out raw)||!(raw is string)||!long.TryParse((string)raw,out requested)||requested<started||requested>Now())throw new IOException("Missing, malformed or out-of-range native QPC");
        if(requested<earliest){earliest=requested;earliestFile=file;}
      }catch(Exception e){uncertainFile=file;uncertainReason=e.Message;}
    }
    if(earliestFile!=null){internalFailure=true;Stop("durable-cancel-request",earliest);}
    if(uncertainFile!=null)UncertainStop(uncertainFile,uncertainReason);
  }
  static void Tick(long started) {
    try {
    long now=Now();ReadDurableStops(started,now);
    bool requested=false;try{using(var e=Barrier("observer-cancel"))requested=e.WaitOne(0);}catch(WaitHandleCannotBeOpenedException){}
    // A notification without valid durable evidence cannot establish its start.
    if(requested&&stopAt==0&&!stopTimestampUncertain)UncertainStop(root,"Cancellation notification has no committed native timestamp");
    foreach(var c in children) { uint w=WaitForSingleObject(c.handle,0);Check(w==0||w==258,"Wait retained original handle");if(w==0&&!c.observed){long exitedAt=Now();c.observed=true;Check(GetExitCodeProcess(c.handle,out c.code),"Exit status");Stop("actor-exit:"+c.role,exitedAt);Event("original-exit-observed","actor",c.role,"pid",c.pid,"creation",c.creation,"exitCode",c.code);if(c.code!=0&&!(mode=="helper-loss"&&c.role=="helper"&&c.code==77))internalFailure=true;} }
    ReadDurableStops(started,Now()); // A request may have committed during exit observation.
    if(now-started>=60*frequency){Stop("operation-budget",started+60*frequency);internalFailure=true;}
    if(!stopTimestampUncertain&&stopAt!=0&&now-stopAt>=5*frequency&&!deadlineMissed&&Active()!=0) {
      deadlineMissed=true;terminateRequired=true;cancelRequired=true;
      Diagnostic(delegate{Save("deadline-missed.json",D("operationStatus","interrupted","strategyVerdict","Invalidated","firstStopQpc",stopAt.ToString(),"observedQpc",now.ToString(),"jobActive",Active(),"authorityEnded",false));},"deadline-missed.json");
      Diagnostic(delegate{Event("drain-deadline-missed");},"supervisor.jsonl");
    }
    }finally{AttemptRequiredActions();}
  }
  static void Await(string name,long started) { using(var e=Barrier(name))while(!e.WaitOne(5)){Tick(started);if(internalFailure||deadlineMissed)throw new IOException("Interrupted at "+name);}Tick(started);if(internalFailure||deadlineMissed)throw new IOException("Interrupted at "+name);Event("barrier-observed","name",name); }
  static bool AllExited() { foreach(var c in children)if(WaitForSingleObject(c.handle,0)!=0)return false;return true; }
  static IntPtr ObserveActor(string actor) { var d=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(P(actor+"-identity.json")));IntPtr h=OpenProcess(0x100000|0x1000,false,Convert.ToUInt32(d["pid"]));Check(h!=IntPtr.Zero,"Observer original actor open");if(Creation(h)!=(string)d["creation"]){CloseHandle(h);throw new IOException("Observer actor creation mismatch");}return h; }
  static int Actor() {
    RequireContained();
    if(role=="blocked") { Signal("blocked-held");Thread.Sleep(Timeout.Infinite);return 0; }
    if(role=="requester") {
      Wait("request-go");long requested=Now();
      if(mode=="interrupted-request")File.WriteAllText(P("requester-cancel-request.pending"),"{\"requestedQpc\":");
      else {
        // No observer-cancel signal follows this commit. Native death is injected
        // before notification; the committed timestamp must still start drain.
        string body=mode=="malformed-request"||mode=="uncertain-write-failure"?"{\"requestedQpc\":\"broken\"}":json.Serialize(D("requestedQpc",requested.ToString(),"requester",role));
        File.WriteAllText(P("requester-staging"),body);File.Move(P("requester-staging"),P("requester-cancel-request.json"));
      }
      Event("request-committed-without-notification","requestedQpc",requested.ToString());Signal("request-committed");Thread.Sleep(Timeout.Infinite);return 0;
    }
    if(role=="helper") { using(var mutex=Mutex.OpenExisting(Name("lease"))) { bool owns=false;try { try{owns=mutex.WaitOne(0);}catch(AbandonedMutexException){owns=true;}Check(owns,"Initial lease");Event("authority-acquired");Signal("helper-held");Wait("helper-release"); }finally{if(owns)mutex.ReleaseMutex();} }return 0; }
    if(role=="writer"||role=="mutator") {
      // Rejected helper-only prototype: admitted work can outlive helper death
      // and ordinary async close. Deliberately ignores cancel while held.
      Signal(role+"-held");Wait(role+"-go");
      if(role=="writer") { File.WriteAllText(P("state.tmp"),"A-published");File.Move(P("state.tmp"),P("state.json"));Event("actual-state-publication-returned"); }
      else { File.Delete(P("disposable-payload"));Event("actual-mutation-returned"); }
      Signal(role+"-published");return 0;
    }
    if(role=="contender") { using(var mutex=Mutex.OpenExisting(Name("lease"))) { bool owns=false;try { Wait("contender-go");bool abandoned=false;try{owns=mutex.WaitOne(10000);}catch(AbandonedMutexException){owns=true;abandoned=true;}Check(owns,"Contender lease");Event("authority-acquired","abandoned",abandoned);File.WriteAllText(P("B-authority"),"B-holds-lease");Signal("B-acquired");Wait("B-release"); }finally{if(owns){Event("authority-releasing");mutex.ReleaseMutex();}} }return 0; }
    if(role=="observer") {
      Wait("observer-go");IntPtr writer=ObserveActor("writer"),mutator=ObserveActor("mutator");
      try { Wait("B-acquired");bool writerAlive=WaitForSingleObject(writer,0)==258,mutatorAlive=WaitForSingleObject(mutator,0)==258;
        using(var mutex=Mutex.OpenExisting(Name("lease"))) { bool acquired=false;try { try{acquired=mutex.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}Check(!acquired,"Independent observer must find B-held lease busy");}finally{if(acquired)mutex.ReleaseMutex();} }
        Check(File.ReadAllText(P("B-authority"))=="B-holds-lease","B actual authority publication");Event("independent-B-authority-observed","writerOriginalAlive",writerAlive,"mutatorOriginalAlive",mutatorAlive);
        if(mode=="helper-loss") { Check(writerAlive&&mutatorAlive,"Both A actors held at B authority");Signal("writer-go");Signal("mutator-go"); }
        Wait("writer-published");Wait("mutator-published");string bytes=File.ReadAllText(P("state.json"));bool payloadPresent=File.Exists(P("disposable-payload"));
        Check(bytes=="A-published"&&!payloadPresent,"Independent actual bytes/mutation");
        // B has not received release and the independent mutex attempt was refused.
        Event("independent-actual-publication-observed","stateBytes",bytes,"payloadPresent",payloadPresent,"overlap",writerAlive&&mutatorAlive);
        Save("observer.json",D("overlap",writerAlive&&mutatorAlive,"writerOriginalAliveAtB",writerAlive,"mutatorOriginalAliveAtB",mutatorAlive,"BLeaseIndependentlyBusy",true,"actualStateBytes",bytes,"actualPayloadPresent",payloadPresent,"qpcFrequency",frequency.ToString()));Signal("observer-done");return 0;
      }finally{CloseHandle(writer);CloseHandle(mutator);}
    }
    throw new IOException("Unknown actor");
  }
  static int Supervisor(string[] args) {
    job=CreateJobObjectW(IntPtr.Zero,Name("job"));int createError=Marshal.GetLastWin32Error();Check(job!=IntPtr.Zero,"Create owned Job");
    if(createError==183){CloseHandle(job);job=IntPtr.Zero;Save("collision-refusal.json",D("containerOwned",false,"actorSpawned",false,"nativeError",createError));return 4;}
    var events=new List<EventWaitHandle>();Mutex lease=null;bool drained=false,completed=false;long started=Now();string error=null;
    try {
      var limits=new Limits();limits.basic.flags=0x2000;Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))),"Kill-on-close owned Job");
      foreach(string name in new string[]{"cancel","observer-cancel","helper-held","helper-release","writer-held","writer-go","writer-published","mutator-held","mutator-go","mutator-published","contender-go","B-acquired","B-release","observer-go","observer-done","blocked-held","request-go","request-committed"}){bool created;var e=new EventWaitHandle(false,EventResetMode.ManualReset,Name(name),out created);events.Add(e);Check(created,"Fresh barrier required");}
      bool fresh;lease=new Mutex(false,Name("lease"),out fresh);Check(fresh,"Fresh fixture lease required");
      Event("owned-container-established","qpcFrequency",frequency.ToString(),"operationSeconds",60,"drainSeconds",5);
      if(mode=="sequential") { Check(args.Length==5,"Node and worker required");Spawn("sequential",args[3],"\""+args[4]+"\" \""+root+"\"");while(!AllExited()){Tick(started);Thread.Sleep(5);}Tick(started);Check(!internalFailure&&!deadlineMissed,"Sequential worker result");completed=true; }
      else if(mode=="notification-loss"||mode=="malformed-request"||mode=="interrupted-request"||mode=="uncertain-write-failure"||mode=="deadline-write-failure") {
        Spawn("blocked");Await("blocked-held",started);Child requester=Spawn("requester");Signal("request-go");
        using(var committed=Barrier("request-committed")) {
          while(!committed.WaitOne(5)){Tick(started);if(stopTimestampUncertain||deadlineMissed)break;}
        }
        // Latch receipt before any exit observation. Uncertain input can already
        // have killed the Job; never act on a reused PID or close the handles.
        Tick(started);
        if(mode=="notification-loss"||mode=="deadline-write-failure") {
          Check(stopAt!=0&&stopCause=="durable-cancel-request","Receipt recovered without notification");
          bool notified;using(var notification=Barrier("observer-cancel"))notified=notification.WaitOne(0);
          Check(!notified,"Notification-loss injection must be real");
          Check(TerminateProcess(requester.handle,78),"Native death after committed request before notification");
          Event("requester-native-death-injected","pid",requester.pid,"creation",requester.creation,"latchedStopQpc",stopAt.ToString());
        }
        else Check(stopTimestampUncertain,"Malformed/interrupted receipt must fail closed");
      }
      else {
        Child helper=Spawn("helper");Await("helper-held",started);Child writer=Spawn("writer"),mutator=Spawn("mutator");
        Save("writer-identity.json",D("pid",writer.pid,"creation",writer.creation));Save("mutator-identity.json",D("pid",mutator.pid,"creation",mutator.creation));
        Spawn("contender");Spawn("observer");Await("writer-held",started);Await("mutator-held",started);Signal("observer-go");Signal("contender-go");
        if(mode=="control") { Signal("writer-go");Signal("mutator-go");while(WaitForSingleObject(writer.handle,0)!=0||WaitForSingleObject(mutator.handle,0)!=0){Tick(started);if(internalFailure||deadlineMissed)throw new IOException("Control drain failed");Thread.Sleep(5);}Signal("helper-release"); }
        else { Check(TerminateProcess(helper.handle,77),"Kill exact original lease helper");while(WaitForSingleObject(helper.handle,0)!=0){Tick(started);Thread.Sleep(1);}Tick(started); }
        Await("observer-done",started);Signal("B-release");completed=true;
      }
    }catch(Exception e){internalFailure=true;error=e.Message;try{Stop("internal-error",Now());Diagnostic(delegate{Save("failure.json",D("operationStatus","interrupted","strategyVerdict","Invalidated","error",error));},"failure.json");}finally{AttemptRequiredActions();}}
    finally {
      if(stopAt==0&&!stopTimestampUncertain)Stop(completed?"completed":"internal-error",Now());
      // Do not close creation handles, release Job supervision, or return to JS
      // until BOTH all exact original handles signal and Job active count is zero.
      while(true) { try{Tick(started);if(AllExited()&&Active()==0){ReadDurableStops(started,Now());drained=true;terminateRequired=false;cancelRequired=false;break;}}catch(Exception e){internalFailure=true;terminateRequired=true;cancelRequired=true;Diagnostic(delegate{Save("drain-error.json",D("error",e.Message,"operationStatus","interrupted","strategyVerdict","Invalidated"));},"drain-error.json");}finally{AttemptRequiredActions();}Thread.Sleep(5); }
      var identities=new List<object>();foreach(var c in children)identities.Add(D("role",c.role,"pid",c.pid,"creation",c.creation,"originalHandleExited",WaitForSingleObject(c.handle,0)==0,"exitCode",c.code));
      Save("terminal-drain.json",D("originalHandlesExited",AllExited(),"jobActive",Active(),"qpc",Now().ToString(),"actors",identities));
      Save("supervisor.json",D("mode",mode,"containerOwned",true,"completed",completed&&!internalFailure&&!deadlineMissed,"operationStatus",internalFailure||deadlineMissed?"interrupted":mode=="helper-loss"?"counterexample-observed":"completed","strategyVerdict",mode=="helper-loss"||internalFailure||deadlineMissed?"Invalidated":"Partial","candidate",false,"firstStopCause",stopCause,"firstStopQpc",stopAt==0?null:stopAt.ToString(),"stopTimestampUncertain",stopTimestampUncertain,"drainObservedQpc",Now().ToString(),"qpcFrequency",frequency.ToString(),"deadlineMissed",deadlineMissed,"diagnosticFailure",diagnosticFailure,"terminationAttempts",terminationAttempts,"terminationSuccesses",terminationSuccesses,"cancelAttempts",cancelAttempts,"lastTerminationError",lastTerminationError,"lastCancellationError",lastCancellationError,"terminationObligationSatisfied",!terminateRequired&&drained,"error",error,"strictDrain",drained,"actors",identities));
      foreach(var c in children)CloseHandle(c.handle);if(lease!=null)lease.Dispose();foreach(var e in events)e.Dispose();CloseHandle(job);
    }
    return internalFailure||deadlineMissed?2:0;
  }
  public static int Main(string[] args) {
    try { Check(QueryPerformanceFrequency(out frequency),"QPC frequency");if(args.Length<3)throw new IOException("Fixed fixture invocation required");role=args[0];Validate(args[1]);mode=args[2];if(mode!="sequential"&&mode!="control"&&mode!="helper-loss"&&mode!="notification-loss"&&mode!="malformed-request"&&mode!="interrupted-request"&&mode!="uncertain-write-failure"&&mode!="deadline-write-failure")throw new IOException("Unknown case");if(role=="supervisor")return Supervisor(args);return Actor(); }
    catch(Exception e) { try{long requested=Now();Save(role+"-cancel-request.pending",D("requestedQpc",requested.ToString(),"requester",role));File.Move(P(role+"-cancel-request.pending"),P(role+"-cancel-request.json"));using(var signal=Barrier("observer-cancel"))signal.Set();Event("actor-error","error",e.Message);Save(role+"-error.json",D("error",e.Message,"operationStatus","interrupted","strategyVerdict","Invalidated"));}catch{}return 3; }
  }
}
