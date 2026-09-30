# Config

## Visão geral

Centraliza diretórios, modelos, valores do detector de fala e parâmetros do
Gateway.

## Responsabilidades

- Preservar caminhos locais compatíveis com a instalação existente.
- Ler variáveis de ambiente e validar valores numéricos.
- Manter padrões compartilhados em uma única configuração.

## Entradas e saídas

- Entradas: variáveis `OPENCLAW_*`, `VOICE_*` e diretório home do usuário.
- Saída: objeto imutável `appConfig`.

## API / Assinatura

```ts
export const appConfig: Readonly<{
  voiceDataDirectory: string;
  whisperModel: string;
  sessionKey: string;
  commandWaitMs: number;
  followUpWaitMs: number;
  chatPollIntervalMs: number;
}>;
```

## Fluxo principal

Resolve diretórios e modelo Whisper, valida ganho/limiar e exporta os valores
consumidos pela captura, inferência, worker e Gateway.

## Tratamento de erros e casos-limite

Valores numéricos não positivos ou não inteiros e comando OpenClaw vazio causam
erro explícito durante a inicialização.

## Exemplos

Configure `VOICE_MIC_SOURCE` e `OPENCLAW_SESSION_KEY` em um arquivo de ambiente
local protegido.

## Dependências e integrações

Usa apenas módulos padrão do Node.js e `process.env`.
