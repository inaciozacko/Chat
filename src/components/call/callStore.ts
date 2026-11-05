import { create } from 'zustand'
import { onCallSignal, sendCallSignal, type CallSignal } from '../../lib/realtime'
import { useChat } from '../../store/chat'

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
  startCall: (conversationId: string, peerId: string, video: boolean) => Promise<void>
  accept: () => Promise<void>
  reject: () => void
  hangup: (reason?: string) => void
  toggleMic: () => void
  toggleCam: () => void
}

let pc: RTCPeerConnection | null = null
let pendingOffer: RTCSessionDescriptionInit | null = null
let pendingIce: RTCIceCandidateInit[] = []
let timeout: number | undefined
let unsub: (() => void) | null = null

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
    window.clearTimeout(timeout)
    pc?.close()
    pc = null
    pendingOffer = null
    pendingIce = []
    get().local?.getTracks().forEach((t) => t.stop())
    set({ phase: 'ended', endReason: reason, local: null, remote: null, ringing: false })
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
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: 1280, height: 720 } : false })
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
      timeout = window.setTimeout(() => get().phase === 'incoming' && cleanup('Chamada perdida'), 45000)
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
        signal('offer', { sdp: offer })
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
  }
})
