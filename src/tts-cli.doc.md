# TTS CLI

## Visão geral

Fornece saída WAV mono para o helper TTS remoto do OpenClaw.

## Responsabilidades

- Ler texto de stdin sem registrá-lo.
- Limpar a resposta falada e delegar a síntese ao worker local.
- Escrever WAV PCM16 somente em stdout.

## Entradas e saídas

- Entrada: até 64 KiB de texto em stdin.
- Saída: WAV mono PCM16 em stdout e código de erro em caso de falha.

## API / Assinatura

```ts
export function main(): Promise<void>;
```

## Fluxo principal

Lê stdin → remove marcação → sintetiza com `pf_dora` → encapsula PCM16 em WAV.

## Tratamento de erros e casos-limite

Texto vazio, entrada excessiva e falha do worker interrompem a execução sem
produzir áudio parcial.

## Exemplos

```bash
printf 'Olá' | node dist/src/tts-cli.js > resposta.wav
```

## Dependências e integrações

Requer `src/tts-worker-client.ts` e o worker Python Kokoro instalado.
