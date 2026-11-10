import { useEffect, useRef, useState } from "react";
import { localAudioApi, type LocalSpeechStatus, type LocalVoiceStatus, type LocalTranscript, type LocalVoiceComparison } from "./local-audio-api";
import "./LocalAudioTools.css";

const message = (error:unknown) => error instanceof Error ? error.message : "本机处理未完成，请检查音频后重试。";
export function LocalAudioTools() {
  const [speech,setSpeech]=useState<LocalSpeechStatus|null>(null);
  const [voice,setVoice]=useState<LocalVoiceStatus|null>(null);
  const [file,setFile]=useState<File|null>(null);
  const [reference,setReference]=useState<File|null>(null);
  const [candidate,setCandidate]=useState<File|null>(null);
  const [confirmed,setConfirmed]=useState(false);
  const [transcript,setTranscript]=useState<LocalTranscript|null>(null);
  const [comparison,setComparison]=useState<LocalVoiceComparison|null>(null);
  const [busy,setBusy]=useState<"speech"|"voice"|null>(null);
  const [error,setError]=useState("");
  const generation=useRef(0);
  useEffect(()=>{
    const id=++generation.current;
    void Promise.allSettled([localAudioApi.speechStatus(),localAudioApi.voiceStatus()]).then(([s,v])=>{
      if(id!==generation.current)return;
      if(s.status==="fulfilled")setSpeech(s.value);
      if(v.status==="fulfilled")setVoice(v.value);
      if(s.status==="rejected"&&v.status==="rejected")setError("本机语音服务暂不可用，请确认桌面后台已启动。");
    });
    return()=>{generation.current++;};
  },[]);
  async function transcribe(){
    if(!file||busy)return;
    if(speech&&file.size>speech.max_bytes){setError("音频过大，请先分段后再转写。");return;}
    const id=generation.current;setBusy("speech");setError("");setTranscript(null);
    try{const result=await localAudioApi.transcribe(file);if(id===generation.current)setTranscript(result);}
    catch(reason){if(id===generation.current)setError(message(reason));}
    finally{if(id===generation.current)setBusy(null);}
  }
  async function compare(){
    if(!reference||!candidate||!confirmed||busy)return;
    if(reference.size>2*1024*1024||candidate.size>2*1024*1024){setError("每段声纹音频最多2MiB，请裁成单人短句。");return;}
    const id=generation.current;setBusy("voice");setError("");setComparison(null);
    try{const result=await localAudioApi.compare(reference,candidate);if(id===generation.current)setComparison(result);}
    catch(reason){if(id===generation.current)setError(message(reason));}
    finally{if(id===generation.current)setBusy(null);}
  }
  return <section className="local-audio-tools" aria-label="本机语音工具">
    <p>音频仅交给这台电脑处理，不发送给文字模型。这里的结果独立于手机当天归档。</p>
    {error&&<p role="alert">{error}</p>}
    <section><header><h4>本地语音转文字</h4><span>{speech? speech.ready?"已准备 · SenseVoice":"模型尚未准备":"正在检查本机模型…"}</span></header>
      <label>选择音频<input type="file" accept="audio/*,.wav,.mp3,.m4a,.webm,.flac" disabled={!!busy} onChange={event=>{setFile(event.target.files?.[0]??null);setTranscript(null);}} /></label>
      <p>支持常见音频，最长30分钟。会谈录音停止后也可直接点“本地转写”。</p>
      <button type="button" disabled={!speech?.ready||!file||!!busy} onClick={()=>void transcribe()}>{busy==="speech"?"正在本地转写…":"开始本地转写"}</button>
      {transcript&&<div className="local-audio-output"><p>音频 {transcript.duration_seconds.toFixed(1)} 秒 · 本机处理 {transcript.elapsed_seconds.toFixed(2)} 秒</p><label>转写原文<textarea readOnly value={transcript.text} rows={7}/></label></div>}
    </section>
    <section><header><h4>本地声音比对</h4><span>{voice?voice.available?"已准备 · CAM++":"模型尚未准备":"正在检查声纹模型…"}</span></header>
      <p>比较两段已裁好的单人语音。相似度不能单独证明身份；尚未登记你的本人声纹。</p>
      <label>参考单人片段<input type="file" accept=".wav,audio/wav" disabled={!!busy} onChange={event=>{setReference(event.target.files?.[0]??null);setComparison(null);}}/></label>
      <label>待比较单人片段<input type="file" accept=".wav,audio/wav" disabled={!!busy} onChange={event=>{setCandidate(event.target.files?.[0]??null);setComparison(null);}}/></label>
      <p>每段需为16kHz、单声道、16-bit PCM WAV，1.5–60秒。</p>
      <label className="local-audio-confirm"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>我已将两段音频裁成可使用的单人语音</label>
      <button type="button" disabled={!voice?.available||!reference||!candidate||!confirmed||!!busy} onClick={()=>void compare()}>{busy==="voice"?"正在本地比对…":"比较两段声音"}</button>
      {comparison&&<div className="local-audio-output" role="status"><strong>余弦相似度 {comparison.similarity.toFixed(3)}</strong><p>这是模型相似度，不是身份置信度。音频与声纹向量未保存。</p></div>}
    </section>
  </section>;
}
