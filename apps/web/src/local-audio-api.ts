import { request } from "./api";
export interface LocalSpeechStatus {ready:boolean;engine:string;model:string;local_only:boolean;missing:string[];max_bytes:number;max_duration_seconds:number;}
export interface LocalTranscript {text:string;duration_seconds:number;elapsed_seconds:number;engine:string;model:string;local_only:true;}
export interface LocalVoiceStatus {available:boolean;model_present:boolean;dependencies_present:boolean;engine:string;mode:string;registered_self:false;note:string;}
export interface LocalVoiceComparison {similarity:number;model_sha256:string;dimension:number;reference_seconds:number;candidate_seconds:number;processing:string;persisted:false;note:string;}
export const localAudioApi = {
  speechStatus: () => request<LocalSpeechStatus>("/local-speech/status"),
  voiceStatus: () => request<LocalVoiceStatus>("/local-voiceprint/status"),
  transcribe: (file:File) => {const body=new FormData();body.append("file",file);return request<LocalTranscript>("/local-speech/transcribe",{method:"POST",body});},
  compare: (reference:File,candidate:File) => {const body=new FormData();body.append("reference",reference);body.append("candidate",candidate);body.append("pretrimmed_speech","true");return request<LocalVoiceComparison>("/local-voiceprint/compare",{method:"POST",body});},
};
