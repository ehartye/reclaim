// Private WP2 candidate, never imported by the product. This partial extension
// uses WP1's reviewed Stop/Tick/receipt-recovery/native-action obligations.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static partial class OwnerLifetimeHarness {
  static string candidateCase;
  static IntPtr candidateLease=IntPtr.Zero;
  static readonly IntPtr InvalidFile=new IntPtr(-1);
  [StructLayout(LayoutKind.Sequential)] struct CandidateId { public ulong volume,low,high; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string p,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr h,int kind,out CandidateId id,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool MoveFileW(string from,string to);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationW(string p,StringBuilder label,uint length,out uint serial,out uint max,out uint flags,StringBuilder fs,uint size);
  static string Data() { return P("namespace\\parent\\data"); }
  static string LeasePath() { return Path.Combine(Data(),"owner.lease"); }
  static Dictionary<string,object> CandidateIdentity(IntPtr h) { CandidateId id;Check(GetFileInformationByHandleEx(h,18,out id,(uint)Marshal.SizeOf(typeof(CandidateId))),"Candidate native object identity");return D("volume",id.volume.ToString("x"),"fileId",id.high.ToString("x16")+id.low.ToString("x16")); }
  static Dictionary<string,object> DirectoryIdentity(string p) { IntPtr h=CreateFileW(p,0x80,7,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);Check(h!=InvalidFile,"Directory identity open");try{return CandidateIdentity(h);}finally{CloseHandle(h);} }
  static IntPtr OpenCandidateLease(out int nativeError) { IntPtr h=CreateFileW(LeasePath(),0xc0000000,0,IntPtr.Zero,4,0x00200000,IntPtr.Zero);nativeError=Marshal.GetLastWin32Error();return h; }
  static bool RefusedIndependentLease() { int error;IntPtr h=OpenCandidateLease(out error);if(h!=InvalidFile){CloseHandle(h);return false;}Check(error==32,"Expected native sharing refusal");return true; }
  static Child CandidateSpawn(string childRole,IntPtr lease) {
    if(lease==IntPtr.Zero){string exe=Process.GetCurrentProcess().MainModule.FileName;return Spawn(childRole,exe,childRole+" \""+root+"\" "+candidateCase);}
    Start start=new Start();start.cb=(uint)Marshal.SizeOf(typeof(Start));PI p;string image=Process.GetCurrentProcess().MainModule.FileName;
    Check(CreateProcessW(image,new StringBuilder("\""+image+"\" "+childRole+" \""+root+"\" "+candidateCase),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,root,ref start,out p),"Candidate suspended creation");
    var child=new Child{role=childRole,handle=p.process,pid=p.pid};children.Add(child);
    try {
      Check(AssignProcessToJobObject(job,p.process),"Candidate assign owned Job");bool inside;Check(IsProcessInJob(p.process,job,out inside)&&inside,"Candidate verify containment");child.creation=Creation(p.process);
      IntPtr remote;Check(DuplicateHandle(GetCurrentProcess(),lease,p.process,out remote,0,false,2),"Duplicate exclusive lease before admission");
      Save(childRole+"-lease.json",D("remoteHandle",remote.ToInt64().ToString(),"identity",CandidateIdentity(lease),"pid",p.pid,"creation",child.creation));
      Event("child-contained-suspended","actor",childRole,"pid",p.pid,"creation",child.creation,"leaseReferenceDuplicated",true,"leaseIdentity",CandidateIdentity(lease));
      Check(ResumeThread(p.thread)!=0xffffffff,"Resume candidate after reference handoff");return child;
    }catch{try{Stop("candidate-spawn-error",Now());}finally{Check(TerminateProcess(p.process,98),"Terminate own unresumed candidate");}throw;}
    finally{CloseHandle(p.thread);}
  }
  static IntPtr ActorReference() {
    var receipt=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(P(role+"-lease.json")));
    Check(Convert.ToUInt32(receipt["pid"])==(uint)Process.GetCurrentProcess().Id&&Creation(GetCurrentProcess())==(string)receipt["creation"],"Reference bound to exact actor");
    IntPtr h=new IntPtr(Convert.ToInt64(receipt["remoteHandle"]));
    var actual=CandidateIdentity(h);Check(json.Serialize(actual)==json.Serialize(receipt["identity"]),"Duplicated native lease identity");
    Event("retained-authority-reference","leaseIdentity",actual,"dataDirectoryIdentity",DirectoryIdentity(Data()));return h;
  }
  static int CandidateActor() {
    RequireContained();
    if(role=="helper"||role=="writer"||role=="mutator") {
      IntPtr reference=ActorReference();
      try {
        Signal(role+"-held");if(role=="helper"){Wait("helper-release");return 0;}
        // Direct writers retain their exclusive reference until their admitted
        // operation ends. No parent/root directory handles are retained here:
        // ancestor replacement is a required adversarial qualification boundary.
        Wait(role+"-go");
        if(role=="writer") { string temp=Path.Combine(Data(),"state.tmp"),state=Path.Combine(Data(),"state.json");File.WriteAllText(temp,"candidate-A-published");File.Replace(temp,state,null);Event("actual-state-publication-returned","directoryIdentity",DirectoryIdentity(Data())); }
        else { File.Delete(Path.Combine(Data(),"disposable-payload"));Event("actual-mutation-returned","directoryIdentity",DirectoryIdentity(Data())); }
        Signal(role+"-published");return 0;
      }finally{CloseHandle(reference);Event("authority-reference-closed");}
    }
    if(role=="replacer") {
      Wait("replacement-go");var before=DirectoryIdentity(Data());bool moved=MoveFileW(P("namespace\\parent"),P("namespace\\retired"));int nativeError=moved?0:Marshal.GetLastWin32Error();
      if(moved){Directory.CreateDirectory(Data());File.WriteAllText(Path.Combine(Data(),"state.json"),"replacement-recovery-unknown");File.WriteAllText(Path.Combine(Data(),"disposable-payload"),"replacement-disposable-payload");}
      var after=DirectoryIdentity(Data());
      Save("namespace-replacement.json",D("moved",moved,"nativeError",nativeError,"before",before,"after",after,"retiredIdentity",moved?DirectoryIdentity(P("namespace\\retired\\data")):null));Event("actual-namespace-replacement-observed","moved",moved,"nativeError",nativeError,"before",before,"after",after);Signal("replacement-done");return 0;
    }
    if(role=="contender") {
      Wait("contender-go");int error;IntPtr lease=OpenCandidateLease(out error);bool acquired=lease!=InvalidFile;
      Save("B-attempt.json",D("acquired",acquired,"nativeError",acquired?0:error,"directoryIdentity",DirectoryIdentity(Data()),"leaseIdentity",acquired?CandidateIdentity(lease):null,"recoveryState","Unknown; acquisition is not consistency"));Event("authority-attempt","acquired",acquired,"nativeError",acquired?0:error);Signal("B-result");
      if(!acquired){Check(error==32,"Candidate competitor must fail closed on sharing conflict");Wait("contender-retry");lease=OpenCandidateLease(out error);Check(lease!=InvalidFile,"Acquire only after both original A exits");}
      try {
        Event("authority-acquired","leaseIdentity",CandidateIdentity(lease),"directoryIdentity",DirectoryIdentity(Data()),"recoveryState","Unknown");
        Save("B-authority.json",D("held",true,"leaseIdentity",CandidateIdentity(lease),"directoryIdentity",DirectoryIdentity(Data()),"recoveryState","Unknown; state and interrupted-operation evidence preserved"));Signal("B-acquired");Wait("B-release");
      }finally{Event("authority-releasing");CloseHandle(lease);Event("authority-closed");}return 0;
    }
    if(role=="observer") {
      Wait("observer-go");IntPtr writer=ObserveActor("writer"),mutator=ObserveActor("mutator");
      try {
        Wait("B-result");var attempt=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(P("B-attempt.json")));bool acquired=Convert.ToBoolean(attempt["acquired"]);if(acquired)Wait("B-acquired");
        bool writerAlive=WaitForSingleObject(writer,0)==258,mutatorAlive=WaitForSingleObject(mutator,0)==258;Check(writerAlive&&mutatorAlive,"Both original A actors held at first B attempt");
        bool leaseBusy=RefusedIndependentLease();Check(leaseBusy,"Independent observer requires exact native sharing conflict");
        Event("independent-first-authority-observation","BAcquired",acquired,"writerOriginalAlive",writerAlive,"mutatorOriginalAlive",mutatorAlive,"leaseBusy",leaseBusy,"directoryIdentity",DirectoryIdentity(Data()));
        Signal("writer-go");Signal("mutator-go");Wait("writer-published");Wait("mutator-published");
        string bytes=File.ReadAllText(Path.Combine(Data(),"state.json"));bool payload=File.Exists(Path.Combine(Data(),"disposable-payload"));Check(bytes=="candidate-A-published"&&!payload,"Independent actual candidate publication and mutation");
        Event("independent-actual-publication-observed","stateBytes",bytes,"payloadPresent",payload,"overlap",acquired,"directoryIdentity",DirectoryIdentity(Data()));
        if(!acquired){Check(WaitForSingleObject(writer,5000)==0&&WaitForSingleObject(mutator,5000)==0,"Original A actor exits before B retry");Signal("contender-retry");}
        Wait("B-acquired");Check(RefusedIndependentLease(),"B authority independently busy until release");
        Save("candidate-observer.json",D("overlap",acquired,"firstAttemptWhileBothAActorsAlive",true,"firstAttemptLeaseBusy",leaseBusy,"BLeaseIndependentlyBusy",true,"actualStateBytes",bytes,"actualPayloadPresent",payload,"directoryIdentity",DirectoryIdentity(Data()),"BFirstAttempt",attempt,"qpcFrequency",frequency.ToString()));Signal("observer-done");return 0;
      }finally{CloseHandle(writer);CloseHandle(mutator);}
    }
    throw new IOException("Unsupported candidate actor");
  }
  static int CandidateSupervisor() {
    job=CreateJobObjectW(IntPtr.Zero,Name("job"));int createError=Marshal.GetLastWin32Error();Check(job!=IntPtr.Zero,"Candidate owned Job");
    if(createError==183){CloseHandle(job);job=IntPtr.Zero;Save("collision-refusal.json",D("containerOwned",false,"actorSpawned",false,"nativeError",createError));return 4;}
    var events=new List<EventWaitHandle>();long started=Now();bool completed=false,drained=false,overlap=false;string error=null;object host=null;
    try {
      var limits=new Limits();limits.basic.flags=0x2000;Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))),"Candidate kill-on-close owned Job");
      foreach(string name in new string[]{"cancel","observer-cancel","helper-held","helper-release","writer-held","writer-go","writer-published","mutator-held","mutator-go","mutator-published","contender-go","contender-retry","B-result","B-acquired","B-release","observer-go","observer-done","replacement-go","replacement-done"}){bool fresh;var e=new EventWaitHandle(false,EventResetMode.ManualReset,Name(name),out fresh);events.Add(e);Check(fresh,"Fresh candidate barrier");}
      uint serial,max,flags;var fs=new StringBuilder(100);Check(GetVolumeInformationW(Path.GetPathRoot(root),null,0,out serial,out max,out flags,fs,100),"Candidate filesystem");Check(fs.ToString()=="NTFS","Only disposable local NTFS candidate lane exercised");
      int nativeError;candidateLease=OpenCandidateLease(out nativeError);Check(candidateLease!=InvalidFile,"Initial candidate exclusive physical lease");
      host=D("filesystem",fs.ToString(),"volumeSerial",serial.ToString("x"),"qpcFrequency",frequency.ToString(),"framework",Environment.Version.ToString(),"is64Bit",Environment.Is64BitProcess,"compatibilityOsVersion",Environment.OSVersion.Version.ToString(),"windowsCurrentBuild",Microsoft.Win32.Registry.GetValue("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion","CurrentBuildNumber",null),"windowsUbr",Microsoft.Win32.Registry.GetValue("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion","UBR",null),"windowsBuildLabEx",Microsoft.Win32.Registry.GetValue("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion","BuildLabEx",null),"fixtureIdentity",DirectoryIdentity(root),"dataDirectoryIdentity",DirectoryIdentity(Data()),"parentIdentity",DirectoryIdentity(P("namespace\\parent")),"leaseIdentity",CandidateIdentity(candidateLease));
      Save("candidate-host.json",host);Event("authority-acquired","leaseIdentity",CandidateIdentity(candidateLease),"dataDirectoryIdentity",DirectoryIdentity(Data()));
      Child helper=CandidateSpawn("helper",candidateLease),writer=CandidateSpawn("writer",candidateLease),mutator=CandidateSpawn("mutator",candidateLease);
      Save("writer-identity.json",D("pid",writer.pid,"creation",writer.creation));Save("mutator-identity.json",D("pid",mutator.pid,"creation",mutator.creation));
      CandidateSpawn("contender",IntPtr.Zero);CandidateSpawn("observer",IntPtr.Zero);if(candidateCase=="ancestor-replacement")CandidateSpawn("replacer",IntPtr.Zero);
      Await("helper-held",started);Await("writer-held",started);Await("mutator-held",started);
      Check(CloseHandle(candidateLease),"Close controller reference after admitted actor handoff");candidateLease=IntPtr.Zero;Event("controller-reference-closed-after-handoff");
      Check(TerminateProcess(helper.handle,77),"Real helper death with actors retaining exclusive references");while(WaitForSingleObject(helper.handle,0)!=0){Tick(started);Thread.Sleep(1);}Tick(started);
      if(candidateCase=="ancestor-replacement"){Signal("replacement-go");Await("replacement-done",started);}
      Signal("observer-go");Signal("contender-go");Await("observer-done",started);
      var observer=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(P("candidate-observer.json")));overlap=Convert.ToBoolean(observer["overlap"]);
      if(overlap)Save("candidate-invalidated.json",D("strategyVerdict","Invalidated","reason","B acquired replacement physical directory while A held references to old lease and could publish/mutate through replaced text path","qpc",Now().ToString(),"candidateStopped",true));
      Signal("B-release");completed=true;
    }catch(Exception e){internalFailure=true;error=e.Message;try{Stop("candidate-internal-error",Now());Diagnostic(delegate{Save("candidate-failure.json",D("operationStatus","interrupted","strategyVerdict","Invalidated","error",error));},"candidate-failure.json");}finally{AttemptRequiredActions();}}
    finally {
      if(stopAt==0&&!stopTimestampUncertain)Stop(completed?"completed":"candidate-internal-error",Now());
      while(true){try{Tick(started);if(AllExited()&&Active()==0){ReadDurableStops(started,Now());drained=true;terminateRequired=false;cancelRequired=false;break;}}catch(Exception e){internalFailure=true;terminateRequired=true;cancelRequired=true;Diagnostic(delegate{Save("candidate-drain-error.json",D("error",e.Message,"operationStatus","interrupted","strategyVerdict","Invalidated"));},"candidate-drain-error.json");}finally{AttemptRequiredActions();}Thread.Sleep(5);}
      var actors=new List<object>();foreach(var c in children)actors.Add(D("role",c.role,"pid",c.pid,"creation",c.creation,"originalHandleExited",WaitForSingleObject(c.handle,0)==0,"exitCode",c.code));
      Save("terminal-drain.json",D("originalHandlesExited",AllExited(),"jobActive",Active(),"qpc",Now().ToString(),"actors",actors));
      Save("candidate-supervisor.json",D("case",candidateCase,"candidate",true,"productionEnabled",false,"completed",completed&&!internalFailure&&!deadlineMissed,"operationStatus",internalFailure||deadlineMissed?"interrupted":overlap?"counterexample-observed":"completed-observation","strategyVerdict",internalFailure||deadlineMissed||overlap?"Invalidated":"Partial","overlap",overlap,"strictDrain",drained,"firstStopQpc",stopAt==0?null:stopAt.ToString(),"firstStopCause",stopCause,"stopTimestampUncertain",stopTimestampUncertain,"deadlineMissed",deadlineMissed,"diagnosticFailure",diagnosticFailure,"terminationAttempts",terminationAttempts,"terminationObligationSatisfied",drained&&!terminateRequired,"drainObservedQpc",Now().ToString(),"qpcFrequency",frequency.ToString(),"host",host,"actors",actors,"error",error));
      // Supervision and any controller reference outlive every mutator.
      if(candidateLease!=IntPtr.Zero&&candidateLease!=InvalidFile)CloseHandle(candidateLease);foreach(var c in children)CloseHandle(c.handle);foreach(var e in events)e.Dispose();CloseHandle(job);
    }
    return internalFailure||deadlineMissed?2:0;
  }
  public static int CandidateMain(string[] args) {
    try {
      Check(QueryPerformanceFrequency(out frequency),"Candidate QPC frequency");if(args.Length!=3)throw new IOException("Fixed candidate invocation required");role=args[0];Validate(args[1]);candidateCase=args[2];
      if(candidateCase!="reference-helper-loss"&&candidateCase!="ancestor-replacement")throw new IOException("Unsupported candidate case");
      // Only the injected helper exit is expected. Do not import the rejected
      // helper-only strategy's Invalidated classification into this candidate.
      mode="reference-retention-candidate";expectedLeaseHelperExit=true;return role=="supervisor"?CandidateSupervisor():CandidateActor();
    }catch(Exception e){try{long at=Now();Save(role+"-cancel-request.pending",D("requestedQpc",at.ToString(),"requester",role));File.Move(P(role+"-cancel-request.pending"),P(role+"-cancel-request.json"));using(var signal=Barrier("observer-cancel"))signal.Set();Save(role+"-candidate-error.json",D("error",e.Message,"operationStatus","interrupted","strategyVerdict","Invalidated"));}catch{}return 3;}
  }
}
public static class OwnerCandidateEntry { public static int Main(string[] args) { return OwnerLifetimeHarness.CandidateMain(args); } }
