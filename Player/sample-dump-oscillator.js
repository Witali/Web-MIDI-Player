// CA-019 pp.2-3: inclusive endpoints, ten distinct playback types.
// The cursor follows an unrolled path. Map its integer neighbours to source
// frames before interpolation, so bounces never duplicate their endpoints.
// Native envelope/filter/mixing still consume this oscillator's Float32 PCM.
export function processSampleDump(voice,count,ratio,output){
 const wave=voice.wavetable,{type,start,end}=wave.sdsPlayback,data=wave.sampleData,n=data.length;
 const reverse=type>=64&&type!==127,looping=type<126,bidirectional=!!(type&1),releaseLoop=!!(type&2);
 const lo=reverse?n-1-end:start,hi=reverse?n-1-start:end,span=hi-lo;
 const period=bidirectional?2*span:span+1;
 let cursor=wave.cursor;
 // Keep repeating paths small, preserving fractional phase through long files.
 if(looping&&period>0&&wave.sdsExit===null&&cursor>hi+period)cursor=hi+(cursor-hi)%period;
 if(looping&&releaseLoop&&voice.isInRelease&&wave.sdsExit===null)
  wave.sdsExit=period>0?hi+Math.max(0,Math.ceil((cursor-hi)/period))*period:Math.max(cursor,hi);
 const source=frame=>{
  let position=frame;
  if(looping){
   if(wave.sdsExit!==null&&frame>wave.sdsExit)position=hi+frame-wave.sdsExit;
   else if(frame>hi){
    if(span===0)position=lo;
    else if(bidirectional){const phase=(frame-hi)%period;position=phase<=span?hi-phase:lo+phase-span;}
    else position=lo+(frame-hi-1)%period;
   }
  }
  if(position<0||position>=n)return 0;
  return data[reverse?n-1-position:position];
 };
 const step=ratio*wave.playbackStep,interpolation=wave.sdsInterpolation;
 let active=true;
 for(let i=0;i<count;i++){
  const pastEnd=looping?(wave.sdsExit!==null&&hi+cursor-wave.sdsExit>=n):cursor>=n;
  if(pastEnd){output.fill(0,i,count);active=false;break;}
  const floor=Math.floor(cursor),t=cursor-floor;
  if(interpolation===1)output[i]=source(floor);
  else if(interpolation===0){const low=source(floor);output[i]=low+(source(floor+1)-low)*t;}
  else{const xm1=source(floor),x0=source(floor+1),x1=source(floor+2),x2=source(floor+3),c=(x1-xm1)*.5,v=x0-x1,w=c+v,a=w+v+(x2-x0)*.5,b=w+a;output[i]=((a*t-b)*t+c)*t+x0;}
  cursor+=step;
 }
 wave.cursor=cursor;return active;
}
