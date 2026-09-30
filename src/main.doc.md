# Main

## Visão geral

Coordena wake word, resposta falada, campainhas e seguimentos da conversa.

## Responsabilidades

- Manter a captura ativa enquanto aguarda a wake word.
- Suspender o microfone durante a fala e chamadas ao Gateway.
- Gerenciar sinais de parada e liberar Whisper, microfone e worker TTS.

## Entradas e saídas

- Entrada: microfone local, Gateway e worker Kokoro.
- Saída: áudio falado e transcrições enviadas ao Gateway; nenhum áudio é salvo.

## API / Assinatura

```ts
export function main(): Promise<void>;
```

## Fluxo principal

Escuta wake word → toca campainha → captura o comando → consulta o Gateway →
fala a resposta → abre janela de seguimento de 15 segundos.

## Tratamento de erros e casos-limite

Erros de captura descartam o trecho e reiniciam o stream. Falhas ao iniciar a
reprodução ou enviar áudio ao dispositivo são rejeitadas e registradas sem
conteúdo transcrito.

## Exemplos

O serviço de usuário executa `dist/src/main.js` após a compilação.

## Dependências e integrações

Requer `parec`, `paplay`, Whisper local, worker Kokoro e CLI OpenClaw.
