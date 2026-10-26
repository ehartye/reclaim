using System;
using System.IO;
using System.Text;
using System.Collections.Generic;

// Directory enumeration supplies cached file-entry lengths. No contents or allocation handles are opened.
public static class ReclaimFolderTotals {
  const int Unsafe = 0x441400;
  static string Native(string p) { return p.StartsWith("\\\\?\\") ? p : "\\\\?\\" + p; }
  static string J(string s) {
    StringBuilder b=new StringBuilder("\"");
    foreach(char c in s) { if(c=='\\'||c=='"')b.Append('\\').Append(c);else if(c<32)b.Append("\\u").Append(((int)c).ToString("x4"));else b.Append(c); }
    return b.Append('"').ToString();
  }
  static void Event(string kind,string p,string reason) { Console.WriteLine("{\"type\":"+J(kind)+",\"path\":"+J(p)+",\"reason\":"+J(reason)+"}"); }
  sealed class Cached { public long Bytes,Files,Stamp,Birth,Directories;public string MeasuredAt;public bool Git; }
  static long Ms(DateTime date) { return (date.ToUniversalTime().Ticks-621355968000000000L)/10000; }
  static void DirectoryRow(string p,long bytes,long files,bool complete,long stamp,long birth,int children,bool git,Cached cache) {
    Console.WriteLine("{\"type\":\"directory\",\"path\":"+J(p)+",\"directBytes\":"+bytes+",\"directFiles\":"+files+",\"complete\":"+(complete?"true":"false")+",\"stamp\":"+stamp+",\"birthStamp\":"+birth+",\"childCount\":"+children+",\"hasGitFile\":"+(git?"true":"false")+",\"estimated\":"+(cache!=null?"true":"false")+(cache!=null?",\"measuredAt\":"+J(cache.MeasuredAt)+",\"cachedDirectories\":"+cache.Directories:"")+"}");
  }
  static Dictionary<string,Cached> Cache(string file) {
    Dictionary<string,Cached> result=new Dictionary<string,Cached>(StringComparer.OrdinalIgnoreCase);
    if(String.IsNullOrEmpty(file))return result;
    foreach(string line in File.ReadLines(Native(file))) {
      string[] p=line.Split('\t');if(p.Length!=8)continue;
      Cached c=new Cached();
      if(long.TryParse(p[1],out c.Bytes)&&long.TryParse(p[2],out c.Files)&&long.TryParse(p[3],out c.Stamp)&&long.TryParse(p[4],out c.Birth)&&long.TryParse(p[5],out c.Directories)) {c.MeasuredAt=p[6];c.Git=p[7]=="1";result[p[0]]=c;}
    }
    return result;
  }
  static bool Within(string p,string root) { return p.Equals(root,StringComparison.OrdinalIgnoreCase)||p.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase); }
  static string Blocked(string p,string[] exclusions,bool cloud) {
    string drive=Path.GetPathRoot(p);
    foreach(string name in new string[]{"Windows","System Volume Information","$Recycle.Bin"})if(Within(p,drive+name))return "Protected system folder";
    string[] parts=p.Split('\\');
    foreach(string part in parts) {
      if(cloud&&part.StartsWith("OneDrive",StringComparison.OrdinalIgnoreCase))return "Cloud folder excluded";
      foreach(string e in exclusions)if(part.Equals(e,StringComparison.OrdinalIgnoreCase)||Within(p,e))return "Your exclusion";
    }
    return null;
  }
  static void Ancestors(string p) {
    for(string current=p;current!=null;) {
      if((((int)File.GetAttributes(Native(current)))&Unsafe)!=0)throw new IOException("Linked, offline or cloud ancestor");
      string next=Path.GetDirectoryName(current);if(next==current)break;current=next;
    }
  }
  public static void Run(string root,string[] exclusions,bool cloud,string cacheFile,long minimum) {
    if(exclusions==null)exclusions=new string[0];
    root=Path.GetFullPath(root);
    if(root.Length<3||root[1]!=':'||root[2]!='\\')throw new IOException("Choose an absolute local drive folder.");
    Ancestors(root);
    Dictionary<string,Cached> cache=Cache(cacheFile);
    Stack<string> pending=new Stack<string>();pending.Push(root);
    while(pending.Count>0) {
      string dir=pending.Pop();long bytes=0,files=0,stamp=0,birth=0;int children=0;bool complete=true,git=false;
      try {
        string blocked=Blocked(dir,exclusions,cloud);
        if(blocked!=null){Event("skip",dir,blocked);continue;}
        Ancestors(dir);
        DirectoryInfo info=new DirectoryInfo(Native(dir));
        if((((int)info.Attributes)&Unsafe)!=0){Event("skip",dir,"Link, offline file or cloud placeholder");continue;}
        stamp=Ms(info.LastWriteTimeUtc);birth=Ms(info.CreationTimeUtc);
        Cached saved;
        if(cache.TryGetValue(dir,out saved)&&saved.Bytes<=minimum&&saved.Stamp==stamp&&saved.Birth==birth) {
          DirectoryRow(dir,saved.Bytes,saved.Files,true,stamp,birth,0,saved.Git,saved);continue;
        }
        DirectoryRow(dir,0,0,false,stamp,birth,0,false,null);
        foreach(FileSystemInfo entry in info.EnumerateFileSystemInfos()) {
          string p=Path.Combine(dir,entry.Name);
          try {
            blocked=Blocked(p,exclusions,cloud);
            if(blocked!=null){Event("skip",p,blocked);complete=false;continue;}
            if((((int)entry.Attributes)&Unsafe)!=0){Event("skip",p,"Link, offline file or cloud placeholder");complete=false;continue;}
            if((entry.Attributes&FileAttributes.Directory)!=0){pending.Push(p);children++;}
            else {bytes=checked(bytes+((FileInfo)entry).Length);files++;if(entry.Name.Equals(".git",StringComparison.OrdinalIgnoreCase))git=true;if(files%1000==0)DirectoryRow(dir,bytes,files,false,stamp,birth,children,git,null);}
          } catch(Exception e){Event("error",p,e.Message);complete=false;}
        }
        info.Refresh();if(Ms(info.LastWriteTimeUtc)!=stamp||Ms(info.CreationTimeUtc)!=birth){complete=false;Event("error",dir,"Folder entries changed while counting; refresh this branch.");}
      } catch(Exception e){Event("error",dir,e.Message);complete=false;}
      DirectoryRow(dir,bytes,files,complete,stamp,birth,children,git,null);
    }
    Console.WriteLine("{\"type\":\"done\"}");
  }
  public static void Inspect(string root,string[] exclusions,bool cloud,int offset,int limit) {
    root=Path.GetFullPath(root);Ancestors(root);if(exclusions==null)exclusions=new string[0];
    string blocked=Blocked(root,exclusions,cloud);if(blocked!=null)throw new IOException(blocked);
    DirectoryInfo info=new DirectoryInfo(Native(root));if((((int)info.Attributes)&Unsafe)!=0)throw new IOException("Unsafe folder");
    int seen=0,returned=0;bool more=false;
    Stack<string> pending=new Stack<string>();pending.Push(root);
    while(pending.Count>0&&!more) {
      string dir=pending.Pop();Ancestors(dir);info=new DirectoryInfo(Native(dir));
      foreach(FileSystemInfo entry in info.EnumerateFileSystemInfos()) {
      string p=Path.Combine(dir,entry.Name);
      try {
        if(Blocked(p,exclusions,cloud)!=null||(((int)entry.Attributes)&Unsafe)!=0){Event("skip",p,"Excluded, linked, offline or cloud entry");continue;}
        if((entry.Attributes&FileAttributes.Directory)!=0){pending.Push(p);continue;}
        if(seen++<offset)continue;if(returned>=limit){more=true;break;}
        Console.WriteLine("{\"type\":\"file\",\"path\":"+J(p)+",\"size\":"+((FileInfo)entry).Length+",\"mtimeMs\":"+Ms(entry.LastWriteTimeUtc)+"}");returned++;
      } catch(Exception e){Event("error",p,e.Message);}
      }
    }
    Console.WriteLine("{\"type\":\"page\",\"nextOffset\":"+(more?(offset+returned).ToString():"null")+"}");
    Console.WriteLine("{\"type\":\"done\"}");
  }
}
