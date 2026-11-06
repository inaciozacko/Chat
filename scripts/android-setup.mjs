// Aplica o código nativo do Zap no projeto Android gerado pelo Capacitor (npx cap add android).
// Roda no GitHub Actions (.github/workflows/android.yml), mas também funciona localmente.
//
//   native-android/java/*.java          → android/app/src/main/java/app/zap/chat/
//   native-android/res/**               → android/app/src/main/res/
//   native-android/google-services.json → android/app/google-services.json  (Firebase)
// e ajusta AndroidManifest.xml (permissões, serviços) e app/build.gradle (dependências, assinatura, versão).

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const nat = path.join(root, 'native-android')
const app = path.join(root, 'android', 'app')
const main = path.join(app, 'src', 'main')
if (!fs.existsSync(main)) throw new Error('Rode antes: npx cap add android')

const log = (...a) => console.log('[android-setup]', ...a)

// ------------------------------------------------------------------ código Java
const javaDest = path.join(main, 'java', 'app', 'zap', 'chat')
fs.mkdirSync(javaDest, { recursive: true })
for (const f of fs.readdirSync(path.join(nat, 'java'))) {
  fs.copyFileSync(path.join(nat, 'java', f), path.join(javaDest, f))
}
log('java:', fs.readdirSync(javaDest).join(', '))

// ------------------------------------------------------------------ recursos (ícones, tela de abertura)
const resDest = path.join(main, 'res')
for (const d of fs.readdirSync(resDest)) {
  // tira a tela de abertura padrão do Capacitor (usamos drawable/splash.xml)
  const p = path.join(resDest, d, 'splash.png')
  if (d.startsWith('drawable') && fs.existsSync(p)) fs.rmSync(p)
}
fs.cpSync(path.join(nat, 'res'), resDest, { recursive: true })
log('res: ícones e splash aplicados')

// ------------------------------------------------------------------ Firebase
const gsDest = path.join(app, 'google-services.json')
if (process.env.GOOGLE_SERVICES_JSON?.trim()) {
  fs.writeFileSync(gsDest, process.env.GOOGLE_SERVICES_JSON)
  log('google-services.json: da variável GOOGLE_SERVICES_JSON')
} else if (fs.existsSync(path.join(nat, 'google-services.json'))) {
  fs.copyFileSync(path.join(nat, 'google-services.json'), gsDest)
  log('google-services.json: de native-android/')
} else {
  log('AVISO: sem google-services.json — o APK funciona, mas sem notificações push')
}

// ------------------------------------------------------------------ AndroidManifest.xml
const manifestPath = path.join(main, 'AndroidManifest.xml')
let manifest = fs.readFileSync(manifestPath, 'utf8')
if (!manifest.includes('ZapMessagingService')) {
  manifest = manifest.replace(
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:tools="http://schemas.android.com/tools"',
  )
  const perms = [
    // notificações e ligações
    'POST_NOTIFICATIONS', 'USE_FULL_SCREEN_INTENT', 'VIBRATE', 'WAKE_LOCK',
    // mensagens de voz, chamadas, câmera
    'RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'CAMERA',
    // modo emergência (Bluetooth / Wi-Fi Direct)
    'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_CONNECTED_DEVICE', 'ACCESS_NETWORK_STATE',
    'ACCESS_WIFI_STATE', 'CHANGE_WIFI_STATE', 'BLUETOOTH_SCAN', 'BLUETOOTH_ADVERTISE', 'BLUETOOTH_CONNECT',
    'NEARBY_WIFI_DEVICES', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION',
  ]
    .map((p) => `    <uses-permission android:name="android.permission.${p}" />`)
    .concat([
      '    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" tools:replace="android:maxSdkVersion" />',
      '    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" tools:replace="android:maxSdkVersion" />',
      '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
      '    <uses-feature android:name="android.hardware.bluetooth" android:required="false" />',
      '    <uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />',
      '    <uses-feature android:name="android.hardware.wifi.direct" android:required="false" />',
    ])
    .join('\n')
  const components = `
        <!-- Zap: push do Firebase (funciona com o app fechado) -->
        <service android:name=".ZapMessagingService" android:exported="false">
            <intent-filter>
                <action android:name="com.google.firebase.MESSAGING_EVENT" />
            </intent-filter>
        </service>
        <!-- Zap: modo emergência (celular a celular, sem internet) -->
        <service android:name=".MeshService" android:exported="false" android:foregroundServiceType="connectedDevice" />
        <!-- Zap: botões das notificações (Responder, Marcar como lida, Recusar) -->
        <receiver android:name=".ActionReceiver" android:exported="false" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_stat_zap" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="messages" />
    </application>`
  manifest = manifest.replace('</application>', components).replace('</manifest>', `${perms}\n</manifest>`)
  fs.writeFileSync(manifestPath, manifest)
  log('AndroidManifest.xml: permissões e serviços adicionados')
}

// ------------------------------------------------------------------ app/build.gradle
const gradlePath = path.join(app, 'build.gradle')
let gradle = fs.readFileSync(gradlePath, 'utf8')
if (!gradle.includes('// zap-setup')) {
  const versionCode = Number(process.env.ZAP_VERSION_CODE || 1)
  const versionName = process.env.ZAP_VERSION_NAME || `1.0.${versionCode}`
  gradle = gradle
    .replace(/versionCode \d+/, `versionCode ${versionCode}`)
    .replace(/versionName "[^"]*"/, `versionName "${versionName}"`)
    .replace(
      'buildTypes {',
      `// zap-setup
    signingConfigs {
        release {
            if (System.getenv("ZAP_KEYSTORE")) {
                storeFile file(System.getenv("ZAP_KEYSTORE"))
                storePassword System.getenv("ZAP_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ZAP_KEY_ALIAS") ?: "zap"
                keyPassword System.getenv("ZAP_KEY_PASSWORD") ?: System.getenv("ZAP_KEYSTORE_PASSWORD")
            }
        }
    }
    lint {
        checkReleaseBuilds false
        abortOnError false
    }
    buildTypes {`,
    )
    .replace(
      /release \{\s*minifyEnabled false/,
      `release {
            if (System.getenv("ZAP_KEYSTORE")) signingConfig signingConfigs.release
            minifyEnabled false`,
    )
    .replace(
      'dependencies {',
      `dependencies {
    // zap: push (Firebase) e modo emergência (Nearby Connections)
    implementation platform("com.google.firebase:firebase-bom:35.0.2")
    implementation "com.google.firebase:firebase-messaging"
    implementation "com.google.android.gms:play-services-nearby:19.5.0"
    implementation "androidx.core:core:$androidxCoreVersion"`,
    )
  fs.writeFileSync(gradlePath, gradle)
  log(`app/build.gradle: versão ${versionName} (${versionCode}), dependências e assinatura`)
}
log('pronto')
