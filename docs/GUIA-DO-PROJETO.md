# Zap: guia do projeto

Este é o documento-base para continuar o desenvolvimento do Zap: onde está cada coisa, como publicar,
o que não pode ser perdido e as armadilhas já conhecidas.

> **Para usar com uma IA (Claude, ChatGPT etc.):** cole ou anexe este arquivo no começo da conversa e diga o que
> quer mudar. A seção [Pedindo mudanças](#13-pedindo-mudanças) tem um texto pronto.

---

## 1. Visão geral

O Zap é um app de mensagens no estilo do WhatsApp:

- conversas e grupos, mensagens de voz, fotos, vídeos, documentos;
- figurinhas com remoção de fundo por IA;
- status, ligações de voz e vídeo, anúncios do administrador;
- notificações push com resposta direto pela notificação;
- **modo emergência** que funciona sem internet.

| O quê | Onde |
|---|---|
| Site (computador e celular) | https://chat-rho-drab.vercel.app |
| Código-fonte | https://github.com/inaciozacko/Chat (público, branch `main`) |
| App Android (APK) | https://github.com/inaciozacko/Chat/releases/latest |
| Banco de dados, login, arquivos | Supabase, projeto `zxtkkejltqxcdwvgzzvw` |
| Notificações do app Android | Firebase, projeto `zapchat-89c93` |
| Registro do app no Google | Android Developer Console, pacote `app.zap.chat` (conta gratuita de distribuição limitada) |
| Pasta local do projeto | `Desktop\Chat\Chat` |

**Tecnologias:**

| Parte | Tecnologia |
|---|---|
| Interface | React 19, TypeScript 7, Vite 8, zustand |
| Banco, login e tempo real | Supabase (Postgres, Auth, Realtime, Storage) |
| Funções do servidor | Vercel (`api/`) |
| App Android | Capacitor 8 + código Java próprio |
| Montagem do APK | GitHub Actions |

---

## 2. Arquitetura em uma figura

```
 Celular (app Android)            Computador / navegador
 ┌──────────────────────┐         ┌──────────────────────┐
 │ WebView com o site   │         │ Site (PWA)           │
 │ + Java (native-android)│       │ + service worker     │
 └──────────┬───────────┘         └──────────┬───────────┘
            │  conversas, login, tempo real  │
            └───────────────┬────────────────┘
                            ▼
                  Supabase (banco + Realtime)
                            ▲
            "avise os outros"  │ lê o banco com a chave secreta
                            │
                  Vercel: api/push.js, api/reply.js
                     │                    │
          Firebase (app Android)    Web Push (navegador)
```

**Caminho de uma mensagem:**
1. O app grava a mensagem no Supabase.
2. Quem está com o app aberto recebe na hora pelo Realtime.
3. O app chama `/api/push`, que avisa por notificação quem está com o app fechado.

**Modo emergência (sem internet):** os celulares trocam mensagens criptografadas por Bluetooth/Wi-Fi Direct, de aparelho em aparelho. Quando algum deles encontra internet, deposita as mensagens na "caixa postal" do Supabase.

---

## 3. Mapa das pastas

```
Chat/
├─ src/                          o app (roda no navegador e dentro do app Android)
│  ├─ App.tsx                    telas principais, abas, botão voltar, modo emergência sem internet
│  ├─ index.css                  TODO o visual (cores no topo: :root e [data-theme='dark'])
│  ├─ store/chat.ts              estado global e ações (enviar, editar, apagar, reagir...)
│  ├─ lib/
│  │  ├─ supabase.ts             conexão com o Supabase + upload de arquivos
│  │  ├─ realtime.ts             mensagens ao vivo, "online", "digitando", sinais das ligações
│  │  ├─ push.ts                 notificações (Web Push no navegador, Firebase no app)
│  │  ├─ native.ts               ponte com o código Android (plugin "Zap")
│  │  ├─ back.ts                 botão voltar do Android (o que fechar primeiro)
│  │  ├─ admin.ts                e-mail(s) do administrador (painel de anúncios)
│  │  ├─ mesh/crypto.ts          criptografia do modo emergência
│  │  ├─ mesh/mesh.ts            lógica do modo emergência (enviar, receber, sincronizar)
│  │  ├─ sticker.ts, bgremoval.ts, segmentation.ts   figurinhas e remoção de fundo
│  │  └─ utils.ts, types.ts, icons.tsx ...
│  └─ components/
│     ├─ chat/                   janela da conversa, mensagens, caixa de texto, áudio
│     ├─ sidebar/                lista de conversas, configurações, perfil, novo grupo
│     ├─ call/, calls/           ligações (WebRTC) e histórico
│     ├─ emergency/              tela do modo emergência
│     ├─ status/, stickers/, emoji/, info/, announcements/
│     └─ common.tsx              Avatar, Menu, Modal, useLongPress, useIsMobile...
├─ api/                          funções da Vercel (servidor)
│  ├─ push.js                    POST /api/push: envia notificações
│  ├─ reply.js                   POST /api/reply: "Responder"/"Marcar como lida"/"Recusar" da notificação
│  └─ _lib/core.js               código comum (montagem das notificações, Firebase, Web Push)
├─ native-android/               código nativo do app Android (aplicado na montagem do APK)
│  ├─ java/*.java                notificações, ligação em tela cheia, botão voltar, modo emergência
│  ├─ res/                       ícones, ícone da barra de notificações, tela de abertura
│  ├─ google-services.json       configuração do Firebase (não é secreto)
│  └─ assets/                    (opcional) arquivos extras que vão dentro do APK
├─ scripts/android-setup.mjs     aplica native-android/ no projeto gerado pelo Capacitor
├─ .github/workflows/android.yml monta o APK a cada envio para o GitHub
├─ capacitor.config.json         configuração do app Android (pacote app.zap.chat)
├─ public/                       arquivos servidos como estão (sw.js, manifest, ícones)
├─ supabase/*.sql                estrutura do banco (ver seção 6)
├─ vercel.json                   cabeçalhos/redirecionamentos do site
└─ docs/                         este guia
```

A pasta `android/` **não fica no GitHub**. Ela é gerada do zero a cada montagem (`npx cap add android`) e recebe as alterações de `native-android/`. Toda mudança no Android deve ser feita em `native-android/` ou em `scripts/android-setup.mjs`, nunca em `android/`.

---

## 4. Rodar no computador

```bash
cd Desktop/Chat/Chat
# na rede da empresa (inspeção de HTTPS), o npm precisa da opção abaixo
NODE_OPTIONS=--use-system-ca npm ci
npm run dev          # abre em http://localhost:5173
npm run build        # confere tipos (tsc) e gera dist/
npx oxlint src api   # verificador de código
```

- Em `npm run dev` **não existe `/api`**, então as notificações push não são enviadas. Para testar contra a Vercel, crie `.env.local` com `VITE_PUSH_API=https://chat-rho-drab.vercel.app/api/push`.
- O app Android **não compila nesta máquina**: o firewall da empresa bloqueia `dl.google.com` (Android SDK). Ele é montado no GitHub Actions.

---

## 5. Publicar uma mudança

1. Altere os arquivos em `Desktop\Chat\Chat`.
2. Envie para o GitHub (`git push` na branch `main`). A partir daí, tudo é automático:
   - a **Vercel** publica o site em 1 a 2 minutos;
   - o **GitHub Actions** monta o APK em 5 a 10 minutos e o publica em **Releases** como `v1.0.<número da execução>`.
3. No celular, baixe o `Zap.apk` da release mais nova e toque nele. Ele **atualiza por cima**, sem desinstalar.

Para acompanhar: na aba **Actions** do repositório, verde quer dizer que deu certo; se ficar vermelho, abra a execução e veja o passo que falhou.

---

## 6. Banco de dados (Supabase)

Os arquivos ficam em `supabase/`. Todos podem ser rodados mais de uma vez no **SQL Editor**.

| Arquivo | O que cria |
|---|---|
| `schema.sql` | **tudo** (inclui os outros abaixo); use num projeto novo |
| `calls.sql` | histórico de ligações |
| `announcements.sql` | anúncios + função `is_app_admin()` (e-mail do administrador) |
| `push.sql` | `push_subscriptions` (navegadores inscritos para notificação) |
| `native.sql` | `native_devices` (celulares com o app), `mesh_keys` e `mesh_envelopes` (modo emergência) |

**Segurança:** o acesso aos dados é controlado pelas políticas RLS do banco. A chave "publishable" que está no código é pública por natureza.

**Trocar o administrador:** mude o e-mail em **dois** lugares, que precisam ficar iguais:
1. `src/lib/admin.ts`, que controla o que aparece na tela;
2. a função `is_app_admin()` em `supabase/announcements.sql`, que controla quem pode publicar. Depois de mudar, rode no SQL Editor.

Hoje o administrador é `inacio@gmail.com`.

---

## 7. Configurações e segredos

### Vercel: Settings → Environment Variables do projeto **chat**

| Variável | Para quê |
|---|---|
| `VAPID_PRIVATE_KEY` | notificações no navegador (Web Push) |
| `SUPABASE_SECRET_KEY` | as funções `api/` leem o banco (chave `sb_secret_...`) |
| `FIREBASE_SERVICE_ACCOUNT` | notificações no app Android (JSON da conta de serviço, em base64) |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | opcionais (o código já tem os valores) |

Depois de mudar qualquer variável, faça **Redeploy**. As variáveis precisam estar no **projeto**, não só na equipe.
Para testar se estão sendo lidas, faça um POST vazio para `/api/push`: a resposta `{"error":"sem login"}` significa que está tudo configurado.

### GitHub: Settings → Secrets and variables → Actions

| Segredo | Para quê |
|---|---|
| `ZAP_KEYSTORE_BASE64` | chave de assinatura do APK |
| `ZAP_KEYSTORE_PASSWORD` | senha da chave |

### Arquivos secretos no computador (nunca subir para o GitHub)

| Arquivo/pasta em `Desktop\Chat\` | Conteúdo |
|---|---|
| `ZAP-ASSINATURA-ANDROID-NAO-SUBIR\` | chave de assinatura do app (`zap-release.jks`, base64 e senha) |
| `CHAVES-PUSH-NAO-SUBIR-NO-GITHUB.txt` | chave privada VAPID (Web Push) |
| `FIREBASE_SERVICE_ACCOUNT-para-a-Vercel-NAO-SUBIR.txt` | conta de serviço do Firebase, em base64 |

> ⚠️ **A chave de assinatura é a identidade do app.** Se ela se perder, nenhuma versão nova instala por cima da
> antiga, e o registro no Android Developer Console deixa de valer. **Mantenha uma cópia fora deste computador**
> (pendrive, Google Drive).
> Impressão digital SHA-256 (pública):
> `60:20:98:A0:3E:75:2D:85:D6:A4:86:78:CA:70:9C:20:F1:92:AD:CA:A2:8E:3B:3D:16:79:CD:53:94:53:8B:A9`

---

## 8. Notificações

**Navegador / PWA (Web Push):**
- `src/lib/push.ts` inscreve o navegador e salva a inscrição em `push_subscriptions`.
- `public/sw.js` mostra a notificação. Ele agrupa as mensagens por conversa, faz a ligação "tocar" de novo e abre a conversa ao tocar.

**App Android (Firebase):**
- O app gera um **segredo do aparelho** e o salva, com o token do Firebase, em `native_devices`. O banco guarda só o hash do segredo.
- `ZapMessagingService.java` recebe o push e `Notifs.java` monta as notificações:
  - mensagem no estilo WhatsApp, com **Responder** e **Marcar como lida**;
  - ligação em **tela cheia**, tocando sem parar, com **Atender** e **Recusar**.
- Os botões da notificação (`ActionReceiver.java`) chamam `/api/reply` com o segredo do aparelho, sem abrir o app.

**Regras gerais:**
- Com o app aberto na tela, não aparece notificação; o próprio app avisa, como no WhatsApp.
- Conversa silenciada não notifica.
- O servidor só aceita pedidos de quem escreveu a mensagem ou fez a ligação, e só de mensagens com menos de 5 minutos.

---

## 9. App Android

- **Pacote:** `app.zap.chat`. **Versão:** `1.0.<execução do Actions>`. O código da versão sobe sozinho a cada envio.
- **Montagem** (`.github/workflows/android.yml`):
  1. `npm ci` e `npm run build`;
  2. `npx cap add android`;
  3. `node scripts/android-setup.mjs`, que aplica o Java, os ícones, o Firebase, as permissões, a assinatura e a versão;
  4. `gradlew assembleRelease`;
  5. publica o APK em Releases.
- **O site vai dentro do APK.** Por isso o app abre sem internet, e cada mudança na interface precisa de um APK novo.
- **Ponte JS ⇄ Android:**
  - lado Java: `native-android/java/ZapPlugin.java`;
  - lado JavaScript: `src/lib/native.ts`.
  - Para criar uma função nova, acrescente um `@PluginMethod` no Java e a assinatura correspondente em `ZapPlugin` no `native.ts`.
- **Botão voltar:** é tratado no JavaScript. Para uma janela, menu ou painel novo fechar com o voltar, use `useBackHandler(aberto, fechar)` de `src/lib/back.ts`. A ordem do resto (sair da conversa, voltar para a lista, minimizar) está em `stepBack()`, no `App.tsx`.
- **Barra de status e barra de gestos:** use as variáveis CSS `--sat` (topo) e `--sab` (base) em qualquer tela nova que ocupe a tela inteira (`position: fixed; inset: 0`).
- **Aviso de "desenvolvedor não verificado / app não seguro":** é o Play Protect do Android. O registro gratuito no Android Developer Console (já feito) **não** o remove. Só a **Play Store** remove (conta de US$ 25; o teste interno aceita até 100 pessoas sem aviso). Para publicar lá, seria preciso:
  - gerar o `.aab`;
  - criar uma política de privacidade;
  - adicionar a opção "Apagar minha conta" dentro do app;
  - preencher as declarações de permissões.

---

## 10. Modo emergência (sem internet)

Fica na aba **SOS / Emergência** do app Android. Se o app abrir sem internet, ele já vai direto para essa tela.

- **Criptografia** (`src/lib/mesh/crypto.ts`):
  - cada aparelho tem chaves P-256: ECDH para receber e ECDSA para assinar;
  - as chaves públicas ficam em `mesh_keys`;
  - cada mensagem é cifrada com AES-GCM para todos os aparelhos do destinatário e assinada.
  - Quem carrega a mensagem vê só: id, de quem, para quem e validade (7 dias).
- **Rádio** (`MeshService.java`, Google Nearby Connections, `P2P_CLUSTER`), quando dois celulares se encontram:
  1. trocam a lista de ids que carregam;
  2. pedem o que falta;
  3. passam os envelopes.
  - Envelope novo é repassado a todos os celulares conectados. A "mochila" (`MeshStore.java`) guarda até 2000 envelopes.
- **Internet** (`src/lib/mesh/mesh.ts`): com qualquer internet, o app publica a chave do aparelho, baixa as chaves dos contatos, deposita a mochila em `mesh_envelopes` (com notificação para o destinatário) e busca as próprias mensagens.
- **Requisitos:**
  - cada pessoa precisa abrir o app **uma vez com internet**, para trocar as chaves;
  - só funciona em Android;
  - só texto e localização (o GPS funciona sem internet).
- **Alcance:** cerca de 30 a 100 m entre cada par de celulares. Distâncias maiores dependem de outros celulares no caminho, ou de alguém levando a mensagem no bolso.

---

## 11. Armadilhas já conhecidas

| Situação | O que fazer |
|---|---|
| TypeScript 7 no projeto | As funções em `api/` são **JavaScript puro**: o compilador da Vercel pode não aceitar TS 7. |
| `Notification` não existe dentro do app Android | Use `notificationPermission()` / `enablePush()` de `src/lib/push.ts`, nunca `Notification.permission` direto. |
| Rede da empresa | Use `NODE_OPTIONS=--use-system-ca` no npm; `dl.google.com` é bloqueado (sem SDK Android local). |
| API do GitHub sem login | É limitada por IP (o IP da empresa é compartilhado). Para acompanhar o Actions, use a página do repositório. |
| Variáveis da Vercel "existem mas não funcionam" | Estão na equipe e não no projeto, ou falta o Redeploy. |
| Mudou o visual e no celular não mudou | O site vai dentro do APK: instale o APK novo. |
| Painéis em coluna (`display:flex; flex-direction:column`) | Elementos de tamanho fixo (fotos, círculos) precisam de `flex-shrink: 0`, senão são espremidos. |
| Arquivo `.md` e pasta `docs/` | Não disparam montagem de APK (o workflow ignora). |

---

## 12. Testes antes de publicar

- [ ] `npm run build` sem erros.
- [ ] Testar no navegador em largura de computador **e** de celular (F12 → modo dispositivo, ~390 px).
- [ ] Mudou algo do Android? Confira a execução no **Actions** (verde) antes de avisar alguém.
- [ ] No celular:
  - [ ] mensagem com o app fechado (notificação + Responder);
  - [ ] ligação com a tela bloqueada;
  - [ ] botão voltar;
  - [ ] modo emergência entre dois celulares, com a internet desligada.

---

## 13. Pedindo mudanças

Texto para começar uma conversa com uma IA:

> Estou continuando o desenvolvimento do meu app **Zap** (clone do WhatsApp em React + Supabase, com app Android em
> Capacitor). Segue o guia do projeto [anexar/colar este arquivo]. O código está em
> https://github.com/inaciozacko/Chat e na pasta `Desktop\Chat\Chat`. Quero: **[descreva a mudança]**.
> Mantenha o padrão do projeto (textos em português, visual em `src/index.css`, código Android em `native-android/`),
> teste no navegador em tamanho de celular e de computador, e me diga exatamente o que publicar.

Ao terminar uma mudança grande, **atualize este guia** (seções 3, 9 ou 11 e o histórico abaixo).

---

## 14. Histórico

| Data | O que mudou |
|---|---|
| 2026-11-05 | Primeira versão: conversas, grupos, mídias, figurinhas com IA, status, ligações, anúncios, mensagens de voz |
| 2026-11-06 | Paleta "ardósia + índigo suave"; PWA; notificações push (Web Push) |
| 2026-11-06 | App Android nativo (Capacitor); notificações pelo Firebase com Responder/Marcar como lida; ligação em tela cheia |
| 2026-11-06 | Modo emergência sem internet (Bluetooth/Wi-Fi em malha + leva e entrega + caixa postal) |
| 2026-11-06 | APK assinado (atualiza por cima); botão voltar do Android; espaço para barra de status/gestos |
| 2026-11-06 | Seleção de mensagens estilo WhatsApp no celular; foto de perfil corrigida; divisória redimensionável; admin `inacio@gmail.com`; app registrado no Android Developer Console |
