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
- **Notificações** do navegador + som, contador no título da aba
- **Tema claro/escuro**, papel de parede, "Enter para enviar", layout responsivo (celular)

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

## Observações

- **Remoção de fundo**: roda 100% no navegador. A IA principal é o **BiRefNet** (`onnx-community/BiRefNet_lite-ONNX`,
  licença MIT) via `@huggingface/transformers`: usa a placa de vídeo (WebGPU, ~115 MB) quando disponível, senão o
  processador (~224 MB). O modelo é baixado só na primeira figurinha e fica em cache. Se não carregar no aparelho,
  o app usa o ISNet (`@imgly/background-removal`, licença AGPL — verifique para uso comercial fechado) e, sem
  internet, a remoção por cor do fundo.
- **Mídia**: os buckets são públicos (URLs com UUID impossíveis de adivinhar). Para privacidade total, troque por
  buckets privados com URLs assinadas.
- **Chamadas**: usam apenas servidores STUN públicos. Em redes muito restritivas pode ser necessário um servidor TURN
  (configure em `src/components/call/callStore.ts`).
- Qualquer usuário cadastrado pode encontrar os outros por nome, usuário ou telefone (não há agenda de contatos).
- Nome, logo e textos são próprios ("Zap"); o visual segue o layout do WhatsApp Web.

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
```
