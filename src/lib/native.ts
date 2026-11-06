import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

/**
 * Ponte com o app Android (native-android/java/ZapPlugin.java).
 * No navegador/PWA nada disso existe: use isNative() antes de chamar.
 */
export const isNative = () => Capacitor.isNativePlatform()

/** no app nativo a página roda em https://localhost, então as funções da Vercel precisam do endereço completo */
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) || 'https://chat-rho-drab.vercel.app').replace(/\/$/, '')

export type MeshStatus = { running: boolean; peers: number; stored: number; carrying: number }

export interface ZapPlugin {
  setSession(o: { apiBase: string; secret: string; userId: string }): Promise<void>
  clearSession(): Promise<void>
  setContacts(o: { contacts: Record<string, string> }): Promise<void>
  getPushToken(): Promise<{ token: string }>
  notificationPermission(): Promise<{ state: string; enabled: boolean }>
  requestNotificationPermission(): Promise<{ state: string; enabled: boolean }>
  clearNotifications(o: { conversationId?: string; callId?: string; mesh?: boolean }): Promise<void>
  /** vai para segundo plano (botão voltar sem nada para fechar) */
  minimize(): Promise<void>

  meshStart(): Promise<MeshStatus>
  meshStop(): Promise<MeshStatus>
  meshStatus(): Promise<MeshStatus>
  meshSend(o: { envelope: string }): Promise<MeshStatus & { stored: boolean }>
  meshAdd(o: { envelopes: string[] }): Promise<MeshStatus & { added: number }>
  meshInbox(): Promise<{ envelopes: string[] }>
  meshConsume(o: { ids: string[] }): Promise<void>
  meshOutbox(): Promise<{ envelopes: string[] }>
  meshMarkUploaded(o: { ids: string[] }): Promise<void>

  addListener(
    event: 'notificationOpen',
    cb: (d: { conversationId?: string; callId?: string; action?: string; mesh?: boolean }) => void,
  ): Promise<PluginListenerHandle>
  addListener(event: 'pushToken', cb: (d: { token: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'meshChanged', cb: (d: MeshStatus) => void): Promise<PluginListenerHandle>
  addListener(event: 'backButton', cb: () => void): Promise<PluginListenerHandle>
}

export const Zap = registerPlugin<ZapPlugin>('Zap')
