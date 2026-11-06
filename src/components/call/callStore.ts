import { create } from 'zustand'
import { onCallSignal, sendCallSignal, type CallSignal } from '../../lib/realtime'
import { useChat } from '../../store/chat'
import { supabase } from '../../lib/supabase'
import { countCameras, deviceIdOf, isMirrored, openCamera, type Facing } from '../../lib/camera'
import { markCallHandled, sendPush } from '../../lib/push'
import { useCallLog } from '../calls/callLog'

/**
 * Chamadas 1:1 de voz e vídeo via WebRTC.
 * A sinalização (offer/answer/ICE) trafega pelo canal privado da conversa no Supabase Realtime.
 * Obs.: sem servidor TURN, chamadas entre redes muito restritivas (NAT simétrico) podem não conectar.
 */

const ICE: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
}

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'ended'

type CallState = {
  phase: CallPhase
  callId: string | null
  conversationId: string | null
  peerId: string | null
  video: boolean
  ringing: boolean
  micOn: boolean
  camOn: boolean
  startedAt: number | null
  endReason: string | null
  local: MediaStream | null
  remote: MediaStream | null
  /** câmera em uso nas chamadas de vídeo (começa na frontal, como no app original) */
  facing: Facing
  mirrorLocal: boolean
  canSwitch: boolean
  switching: boolean
  startCall: (conversationId: string, peerId: string, video: boolean) => Promise<void>
  accept: () => Promise<void>
  reject: () => void
  hangup: (reason?: string) => void
  toggleMic: () => void
  toggleCam: () => void
  switchCamera: () => Promise<void>
}

let pc: RTCPeerConnection | null = null
let pendingOffer: RTCSessionDescriptionInit | null = null
let pendingIce: RTCIceCandidateInit[] = []
let timeout: number | undefined
let unsub: (() => void) | null = null
/**
 * Enquanto chama, reenvia a oferta a cada 3 s: quem estava com o app fechado recebe o push,
 * toca na notificação, o app abre e pega a próxima oferta (com todos os candidatos ICE no SDP).
 */
let reofferTimer: number | undefined
/** chamadas já tratadas neste aparelho (ignora as ofertas repetidas delas) */
const seenCalls = new Set<string>()
/** "Atender" tocado na notificação antes de o app abrir */
let autoAnswer: { id: string; at: number } | null = null

export function answerWhenRinging(callId: string) {
  const st = useCall.getState()
  if (st.callId === callId && st.phase === 'incoming') {
    st.accept()
    return
  }
  autoAnswer = { id: callId, at: Date.now() }
}

function myId() {
  return useChat.getState().session?.user.id ?? ''
}

export const useCall = create<CallState>((set, get) => {
  const signal = (kind: CallSignal['kind'], extra: Partial<CallSignal> = {}) => {
    const { callId, conversationId, peerId, video } = get()
    if (!callId || !conversationId || !peerId) return
    sendCallSignal({ kind, callId, conversationId, from: myId(), to: peerId, video, ...extra })
  }

  const cleanup = (reason: string | null) => {
    // registra o fim no histórico de ligações (quem chegar primeiro grava; o outro lado é ignorado)
    const { callId, phase } = get()
    if (callId && phase !== 'ended' && phase !== 'idle') {
      const now = new Date().toISOString()
      const status =
        reason === 'Chamada recusada'
          ? 'rejected'
          : reason === 'Ocupado em outra chamada'
            ? 'busy'
            : reason === 'Falha na conexão' || reason === null
              ? 'failed'
              : 'missed'
      const patch = phase === 'connected' ? { ended_at: now } : { ended_at: now, status }
      const update = supabase.from('calls').update(patch).eq('id', callId).is('ended_at', null)
      // quem ligou desistiu / ninguém atendeu: a notificação do outro lado vira "Chamada perdida"
      if (phase === 'outgoing' && (reason === 'Sem resposta' || reason === 'Chamada encerrada')) {
        update.then(() => sendPush({ type: 'call_end', call_id: callId }))
      } else update.then()
    }
    if (callId) markCallHandled(callId)
    window.clearTimeout(timeout)
    window.clearInterval(reofferTimer)
    pc?.close()
    pc = null
    pendingOffer = null
    pendingIce = []
    get().local?.getTracks().forEach((t) => t.stop())
    set({ phase: 'ended', endReason: reason, local: null, remote: null, ringing: false, switching: false })
    setTimeout(() => {
      if (get().phase === 'ended')
        set({ phase: 'idle', callId: null, conversationId: null, peerId: null, startedAt: null, endReason: null })
    }, 1800)
  }

  const createPc = () => {
    const conn = new RTCPeerConnection(ICE)
    const remote = new MediaStream()
    set({ remote })
    conn.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach((t) => remote.addTrack(t))
      if (!e.streams[0]) remote.addTrack(e.track)
      set({ remote: new MediaStream(remote.getTracks()) })
    }
    conn.onicecandidate = (e) => e.candidate && signal('ice', { candidate: e.candidate.toJSON() })
    conn.onconnectionstatechange = () => {
      if (conn.connectionState === 'connected') {
        window.clearTimeout(timeout)
        set({ phase: 'connected', startedAt: Date.now() })
        const { callId } = get()
        if (callId)
          supabase
            .from('calls')
            .update({ status: 'answered', answered_at: new Date().toISOString() })
            .eq('id', callId)
            .eq('status', 'ringing')
            .then()
      }
      if (conn.connectionState === 'failed') {
        signal('end')
        cleanup('Falha na conexão')
      }
    }
    pc = conn
    return conn
  }

  const getMedia = async (video: boolean) => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: 'user' } } : false,
      })
      if (video) {
        set({ facing: 'user', mirrorLocal: isMirrored(s, 'user'), canSwitch: false })
        countCameras().then((n) => set({ canSwitch: n > 1 }))
      }
      return s
    } catch {
      if (video) {
        // sem câmera: tenta só áudio
        try {
          set({ camOn: false })
          return await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch {
          /* cai no erro abaixo */
        }
      }
      throw new Error('Permita o acesso ao microfone/câmera para fazer chamadas')
    }
  }

  const onSignal = async (sig: CallSignal) => {
    const st = get()
    if (sig.kind === 'offer') {
      if (seenCalls.has(sig.callId)) {
        // oferta repetida da mesma chamada: só confirma que está tocando aqui
        if (st.callId === sig.callId && st.phase === 'incoming')
          sendCallSignal({ ...sig, kind: 'ringing', from: myId(), to: sig.from, sdp: undefined })
        return
      }
      seenCalls.add(sig.callId)
      if (st.phase !== 'idle' && st.phase !== 'ended') {
        sendCallSignal({ ...sig, kind: 'busy', from: myId(), to: sig.from, sdp: undefined })
        return
      }
      pendingOffer = sig.sdp ?? null
      pendingIce = []
      set({
        phase: 'incoming',
        callId: sig.callId,
        conversationId: sig.conversationId,
        peerId: sig.from,
        video: !!sig.video,
        camOn: !!sig.video,
        micOn: true,
        endReason: null,
      })
      sendCallSignal({ ...sig, kind: 'ringing', from: myId(), to: sig.from, sdp: undefined })
      // app na tela: a tela de chamada assume, então a notificação que estava tocando some
      if (document.visibilityState === 'visible') markCallHandled(sig.callId)
      timeout = window.setTimeout(() => get().phase === 'incoming' && cleanup('Chamada perdida'), 45000)
      // tocou em "Atender" na notificação: atende sozinho assim que a chamada chega
      if (autoAnswer && autoAnswer.id === sig.callId && Date.now() - autoAnswer.at < 60_000) {
        autoAnswer = null
        window.setTimeout(() => get().accept(), 300)
      }
      return
    }
    if (sig.callId !== st.callId) return
    switch (sig.kind) {
      case 'ringing':
        set({ ringing: true })
        break
      case 'answer':
        if (pc && sig.sdp) {
          set({ phase: 'connecting' })
          await pc.setRemoteDescription(sig.sdp)
          for (const c of pendingIce) await pc.addIceCandidate(c).catch(() => {})
          pendingIce = []
        }
        break
      case 'ice':
        if (!sig.candidate) break
        if (pc?.remoteDescription) await pc.addIceCandidate(sig.candidate).catch(() => {})
        else pendingIce.push(sig.candidate)
        break
      case 'reject':
        cleanup('Chamada recusada')
        break
      case 'busy':
        cleanup('Ocupado em outra chamada')
        break
      case 'end':
        cleanup(st.phase === 'incoming' ? 'Chamada perdida' : 'Chamada encerrada')
        break
    }
  }

  unsub?.()
  unsub = onCallSignal(onSignal)

  return {
    phase: 'idle',
    callId: null,
    conversationId: null,
    peerId: null,
    video: false,
    ringing: false,
    micOn: true,
    camOn: true,
    startedAt: null,
    endReason: null,
    local: null,
    remote: null,
    facing: 'user',
    mirrorLocal: true,
    canSwitch: false,
    switching: false,

    startCall: async (conversationId, peerId, video) => {
      if (get().phase !== 'idle' && get().phase !== 'ended') return
      set({
        phase: 'outgoing',
        callId: crypto.randomUUID(),
        conversationId,
        peerId,
        video,
        camOn: video,
        micOn: true,
        ringing: false,
        endReason: null,
      })
      try {
        const local = await getMedia(video)
        set({ local })
        const conn = createPc()
        local.getTracks().forEach((t) => conn.addTrack(t, local))
        if (!video) conn.addTransceiver('video', { direction: 'recvonly' })
        const offer = await conn.createOffer()
        await conn.setLocalDescription(offer)
        // registra no histórico antes de tocar no outro lado (falha aqui não impede a chamada)
        const { error } = await supabase.from('calls').insert({
          id: get().callId,
          conversation_id: conversationId,
          caller_id: myId(),
          callee_id: peerId,
          video,
        })
        if (error) console.warn('Histórico de ligações indisponível:', error.message)
        if (get().phase !== 'outgoing') return
        signal('offer', { sdp: offer })
        // app do outro lado fechado: o push faz o celular tocar
        sendPush({ type: 'call', call_id: get().callId! })
        window.clearInterval(reofferTimer)
        reofferTimer = window.setInterval(() => {
          if (get().phase !== 'outgoing' || !pc?.localDescription) return window.clearInterval(reofferTimer)
          // recusada pelo botão "Recusar" da notificação (o outro lado nem abriu o app)
          const row = useCallLog.getState().list?.find((c) => c.id === get().callId)
          if (row?.status === 'rejected') return cleanup('Chamada recusada')
          signal('offer', { sdp: pc.localDescription.toJSON() })
        }, 3000)
        timeout = window.setTimeout(() => {
          if (get().phase === 'outgoing') {
            signal('end')
            cleanup('Sem resposta')
          }
        }, 45000)
      } catch (e) {
        useChat.getState().showToast((e as Error).message)
        cleanup(null)
      }
    },

    accept: async () => {
      if (get().phase !== 'incoming' || !pendingOffer) return
      window.clearTimeout(timeout)
      set({ phase: 'connecting' })
      try {
        const local = await getMedia(get().video)
        set({ local })
        const conn = createPc()
        await conn.setRemoteDescription(pendingOffer)
        local.getTracks().forEach((t) => conn.addTrack(t, local))
        const answer = await conn.createAnswer()
        await conn.setLocalDescription(answer)
        signal('answer', { sdp: answer })
        for (const c of pendingIce) await conn.addIceCandidate(c).catch(() => {})
        pendingIce = []
      } catch (e) {
        useChat.getState().showToast((e as Error).message)
        signal('reject')
        cleanup(null)
      }
    },

    reject: () => {
      signal('reject')
      cleanup('Chamada recusada')
    },

    hangup: (reason = 'Chamada encerrada') => {
      signal('end')
      cleanup(reason)
    },

    toggleMic: () => {
      const on = !get().micOn
      get().local?.getAudioTracks().forEach((t) => (t.enabled = on))
      set({ micOn: on })
    },

    toggleCam: () => {
      const on = !get().camOn
      get().local?.getVideoTracks().forEach((t) => (t.enabled = on))
      set({ camOn: on })
    },

    switchCamera: async () => {
      const { local, facing, camOn, switching } = get()
      const old = local?.getVideoTracks()[0]
      if (!local || !old || switching) return
      set({ switching: true })
      const next: Facing = facing === 'user' ? 'environment' : 'user'
      const prevId = deviceIdOf(local)
      old.stop() // celulares não abrem duas câmeras ao mesmo tempo
      let used = next
      let fresh = await openCamera(next, prevId).catch(() => null)
      if (!fresh) {
        used = facing
        fresh = await openCamera(facing).catch(() => null)
      }
      const cur = get()
      if (cur.local !== local || cur.phase === 'ended' || cur.phase === 'idle') {
        fresh?.getTracks().forEach((t) => t.stop()) // chamada acabou enquanto trocava
        return
      }
      if (!fresh) {
        useChat.getState().showToast('Não foi possível trocar a câmera')
        set({ switching: false, camOn: false })
        return
      }
      const track = fresh.getVideoTracks()[0]
      track.enabled = camOn
      // troca o vídeo enviado sem renegociar a chamada
      const sender = pc?.getSenders().find((s) => s.track === old || s.track?.kind === 'video')
      await sender?.replaceTrack(track).catch(() => {})
      set({
        local: new MediaStream([...local.getAudioTracks(), track]),
        facing: used,
        mirrorLocal: isMirrored(fresh, used),
        switching: false,
      })
      if (used !== next) useChat.getState().showToast('Não foi possível trocar a câmera')
    },
  }
})
