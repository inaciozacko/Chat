import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { AppLogo, IconLock } from '../lib/icons'
import { Spinner } from './common'

export function Auth() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setLoading(true)
    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      } else {
        if (username && !/^[a-z0-9_.]{3,30}$/i.test(username))
          throw new Error('Nome de usuário: 3 a 30 caracteres (letras, números, _ ou .)')
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName, username: username.toLowerCase(), phone } },
        })
        if (error) throw error
        if (!data.session) setInfo('Conta criada! Confirme seu e-mail para entrar.')
      }
    } catch (err) {
      const msg = (err as Error).message
      setError(
        msg.includes('Invalid login credentials')
          ? 'E-mail ou senha incorretos.'
          : msg.includes('already registered')
            ? 'Este e-mail já está cadastrado.'
            : msg,
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-top">
        <AppLogo size={36} />
        <span>ZAP WEB</span>
      </div>
      <div className="auth-card">
        <div className="auth-left">
          <h1>{mode === 'login' ? 'Entrar no Zap' : 'Criar sua conta'}</h1>
          <ol>
            <li>Converse em tempo real com seus contatos e grupos.</li>
            <li>Envie fotos, vídeos, documentos e mensagens de voz.</li>
            <li>Crie figurinhas a partir de qualquer foto, com remoção automática de fundo.</li>
          </ol>
          <p className="auth-lock">
            <IconLock size={14} /> Suas conversas ficam salvas no seu Supabase.
          </p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          {mode === 'signup' && (
            <>
              <label>
                Nome
                <input required value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={25} />
              </label>
              <label>
                Nome de usuário
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="ex.: maria.silva"
                  maxLength={30}
                />
              </label>
              <label>
                Telefone (opcional)
                <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+55 11 91234-5678" />
              </label>
            </>
          )}
          <label>
            E-mail
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </label>
          <label>
            Senha
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          {info && <div className="auth-info">{info}</div>}
          <button className="btn-primary big" disabled={loading}>
            {loading ? <Spinner size={20} /> : mode === 'login' ? 'Entrar' : 'Cadastrar'}
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login')
              setError(null)
              setInfo(null)
            }}
          >
            {mode === 'login' ? 'Não tem conta? Cadastre-se' : 'Já tem conta? Entrar'}
          </button>
        </form>
      </div>
    </div>
  )
}

export function SetupScreen() {
  return (
    <div className="auth-page">
      <div className="auth-top">
        <AppLogo size={36} />
        <span>ZAP WEB</span>
      </div>
      <div className="auth-card setup">
        <h1>Configure o Supabase</h1>
        <ol>
          <li>
            Crie um projeto em <b>supabase.com</b> e rode o arquivo <code>supabase/schema.sql</code> no SQL Editor.
          </li>
          <li>
            Copie <code>.env.example</code> para <code>.env.local</code> e preencha <code>VITE_SUPABASE_URL</code> e{' '}
            <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>.
          </li>
          <li>
            Reinicie o servidor com <code>npm run dev</code>.
          </li>
        </ol>
      </div>
    </div>
  )
}
