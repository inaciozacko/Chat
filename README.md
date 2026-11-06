# Zap — chat em tempo real com Supabase

Clone funcional no estilo do WhatsApp Web, feito com React + TypeScript + Vite e Supabase
(Auth, Postgres, Realtime e Storage).

## Funcionalidades

- **Conta**: cadastro/login por e-mail e senha, perfil com foto, nome, recado, usuário e telefone
- **Conversas 1:1 e grupos**, conversa consigo mesmo
- **Tempo real**: mensagens, reações, edições e exclusões chegam na hora
- **Online / visto por último**, **digitando...**
- **Ticks**: ✓ enviada, ✓✓ entregue, ✓✓ azul lida (usando o relógio do servidor)
- **Mensagens**: texto com formatação (`*negrito*`, `_itálico_`, `~tachado~`, ` ```mono``` `), links, emojis grandes
- **Emojis animados** (estilo Teams): nas mensagens e na barra de reações mexem sem parar enquanto estão na tela;
  painel de emojis próprio (categorias, recentes, busca em português) em que o emoji se mexe ao passar o mouse.
  881 emojis têm animação; os demais (ex.: bandeiras) aparecem no mesmo estilo 3D, parados. Pode desligar em Configurações
- **Mensagens de voz**: no computador, clique no microfone (pausar, descartar, enviar); no celular, segure para gravar,
  solte para enviar, deslize para a esquerda para cancelar ou para cima para travar. Mostra "gravando áudio..." para o outro lado
- **Mídia**: fotos, vídeos, documentos e áudios (arquivos), com prévia e legenda antes de enviar, câmera, colar imagem (Ctrl+V), arrastar e soltar
- **Responder**, **encaminhar** (até 5 conversas), **reagir** (barra rápida + todos os emojis, duplo clique = ❤️),
  **editar** (até 15 min, ↑ edita a última), **apagar para mim / para todos**, **favoritar**, **selecionar várias**
- **Figurinhas**: crie a partir de qualquer imagem, com **remoção de fundo automática no navegador**
  (IA, `@imgly/background-removal`), contorno branco, texto, recorte circular/arredondado, emoji para busca.
  Lista pessoal salva no Supabase, favoritas, salvar figurinha recebida, "Criar figurinha" a partir de uma foto da conversa
- **Lista de conversas**: fixar (até 3), arquivar, silenciar, marcar como não lida, limpar, apagar/sair, filtros (Tudo, Não lidas, Fixadas, Grupos), busca
- **Grupos**: foto, nome, descrição, admins, adicionar/remover participantes, promover admin, sair, mensagens de sistema
- **Dados do contato/grupo**: mídia, links e docs, grupos em comum, favoritas
- **Pesquisa de mensagens** na conversa, com salto até a mensagem
- **Status** (24h): texto com fundo colorido ou foto, visualizações, responder status
- **Chamadas de voz e vídeo** 1:1 (WebRTC, sinalização pelo Supabase Realtime)
- **Notificações push** (como no WhatsApp): chegam com o app fechado e a tela desligada, agrupadas por conversa
  ("Fulano (3 mensagens)"), ligações "tocam" até atender e viram "Chamada perdida"; tocar abre a conversa.
  Conversas silenciadas não notificam. Som no app + contador no título da aba
- **App Android / PWA**: instalável pelo Chrome e empacotável como APK (TWA) — veja "App Android" abaixo
- **Tema claro/escuro** (paleta ardósia + índigo suave), papel de parede, "Enter para enviar", layout responsivo (celular)

## Configuração

1. Crie um projeto em [supabase.com](https://supabase.com).
2. No **SQL Editor**, cole e rode todo o arquivo [`supabase/schema.sql`](supabase/schema.sql).
   Ele cria tabelas, RLS, funções, triggers, buckets de storage e ativa o Realtime.
3. Em **Authentication → Providers → Email**, para testar mais rápido você pode desativar *Confirm email*.
4. Em **Realtime → Settings**, deixe *Allow public access* ativado (usado pelo canal de presença "online").
   Os canais de cada conversa são **privados** e protegidos por policies.
5. Copie `.env.example` para `.env.local` e preencha:
   ```
   VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   ```
6. Rode:
   ```
   npm install
   npm run dev
   ```
   Abra em duas abas/navegadores com contas diferentes para conversar.

## Notificações push

1. No **SQL Editor** do Supabase, rode [`supabase/push.sql`](supabase/push.sql) (tabela dos aparelhos inscritos).
2. Na **Vercel** (Settings → Environment Variables), crie:
   - `VAPID_PRIVATE_KEY` — chave privada do par VAPID (a pública está em `src/lib/push.ts` e `api/push.js`)
   - `SUPABASE_SECRET_KEY` — Supabase → Project Settings → API Keys → *Secret key* (`sb_secret_...`)
3. Faça o deploy de novo. A função `api/push.js` vira `https://SEU-APP.vercel.app/api/push`.

Como funciona: depois de enviar uma mensagem ou ligar, o app chama `/api/push`; a função confere no banco
(só o autor da mensagem / quem ligou pode disparar) e envia o push aos outros participantes.
`public/sw.js` (service worker) mostra a notificação. Em `npm run dev` não há `/api` — o push só funciona na Vercel.

## App Android

App **nativo** (Capacitor 8, pacote `app.zap.chat`), montado na nuvem pelo GitHub Actions
(`.github/workflows/android.yml`) a cada envio — o APK aparece na aba **Releases** do repositório.
Não precisa instalar Android Studio.

- `capacitor.config.json` — configuração do app; o site vai **dentro** do APK (abre sem internet).
- `native-android/java/` — código Android: notificações do Firebase com **Responder** e **Marcar como lida**,
  ligação em tela cheia tocando sem parar, e o **modo emergência** (Nearby Connections).
- `native-android/res/` — ícones, ícone da barra de notificações e tela de abertura.
- `native-android/google-services.json` — arquivo do Firebase (do seu projeto).
- `scripts/android-setup.mjs` — aplica tudo isso no projeto gerado por `npx cap add android`.

Configuração (uma vez):
1. Supabase: rode [`supabase/native.sql`](supabase/native.sql).
2. Firebase: crie o projeto, adicione um app Android `app.zap.chat`, baixe o `google-services.json` para
   `native-android/` e gere uma **chave de conta de serviço** (Configurações do projeto → Contas de serviço).
3. Vercel: variável `FIREBASE_SERVICE_ACCOUNT` = conteúdo do JSON da conta de serviço.
4. GitHub (Settings → Secrets and variables → Actions): `ZAP_KEYSTORE_BASE64` e `ZAP_KEYSTORE_PASSWORD`
   (a chave de assinatura; use **sempre a mesma**, senão o celular não aceita atualizar).

### Modo emergência (sem internet)

Aba **Emergência** no app Android. As mensagens vão **criptografadas** (`src/lib/mesh/crypto.ts`) e chegam por:
- **Bluetooth/Wi-Fi Direct**, de celular em celular (uns 30–100 m entre cada um), pulando por quem estiver no caminho;
- **"leva e entrega"**: cada celular guarda as mensagens dos outros (até 7 dias) e entrega quando encontrar o destino;
- **internet**: qualquer celular que carregue a mensagem e encontre internet a deposita em `mesh_envelopes`,
  e o destinatário recebe com notificação.

Cada pessoa precisa abrir o app **uma vez com internet** (para publicar sua chave e baixar a dos contatos).
Atalhos: "Estou bem", "Preciso de ajuda" e "Minha localização" (GPS funciona sem internet) para todos os contatos.
Se o app abrir sem internet, ele vai direto para o modo emergência.

## Observações

- **Remoção de fundo**: roda 100% no navegador. A IA principal é o **BiRefNet** (`onnx-community/BiRefNet_lite-ONNX`,
  licença MIT) via `@huggingface/transformers`: usa a placa de vídeo (WebGPU, ~115 MB) quando disponível, senão o
  processador (~224 MB). O modelo é baixado só na primeira figurinha e fica em cache. Se não carregar no aparelho,
  o app usa o ISNet (`@imgly/background-removal`, licença AGPL — verifique para uso comercial fechado) e, sem
  internet, a remoção por cor do fundo.
- **Emojis animados**: [Noto Emoji Animation](https://googlefonts.github.io/noto-emoji-animation/) © Google, licença
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Os arquivos Lottie (~60 KB cada) são baixados de `fonts.gstatic.com`
  só quando o emoji aparece na tela e ficam em cache.
- **Mídia**: os buckets são públicos (URLs com UUID impossíveis de adivinhar). Para privacidade total, troque por
  buckets privados com URLs assinadas.
- **Chamadas**: usam apenas servidores STUN públicos. Em redes muito restritivas pode ser necessário um servidor TURN
  (configure em `src/components/call/callStore.ts`).
- Qualquer usuário cadastrado pode encontrar os outros por nome, usuário ou telefone (não há agenda de contatos).
- Nome, logo e textos são próprios ("Zap"); o layout é inspirado no WhatsApp Web, com paleta própria.

## Estrutura

```
supabase/schema.sql            banco, RLS, RPCs, storage, realtime
src/lib/supabase.ts            cliente + upload
src/lib/realtime.ts            postgres_changes, presença, digitando, sinalização de chamadas
src/lib/sticker.ts             remoção de fundo + composição da figurinha (512x512 WebP)
src/store/chat.ts              estado global (zustand) e todas as ações
src/components/sidebar/        lista de conversas, nova conversa, grupo, perfil, configurações, favoritas
src/components/chat/           janela, bolhas, composer, prévia de mídia, player de áudio
src/components/stickers/       painel e criador de figurinhas
src/components/status/         status (stories)
src/components/info/           dados do contato/grupo, pesquisa, encaminhar, visualizador
src/components/call/           chamadas WebRTC
src/lib/push.ts                inscrição no push, envio para /api/push
api/push.js                    função da Vercel que envia as notificações push
public/sw.js                   service worker: mostra/agrupa notificações, cache offline
public/manifest.webmanifest    PWA (app instalável / APK Android)
supabase/push.sql              tabela dos aparelhos inscritos no push
```
