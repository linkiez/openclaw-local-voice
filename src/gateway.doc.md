# Gateway

## Visão geral

Adapta a CLI OpenClaw e mantém cada turno de voz na sessão persistente.

## Responsabilidades

- Chamar `openclaw gateway call` sem shell.
- Validar respostas JSON e extrair texto do histórico.
- Enviar a transcrição e aguardar a conclusão do `runId`.

## Entradas e saídas

- Entradas: comando transcrito, `sessionKey`, `agentId` e respostas Gateway.
- Saída: texto da resposta final do assistente.

## API / Assinatura

```ts
export function createGatewayCall(
  executable?: string,
  runCommand?: GatewayCommandRunner,
): GatewayCall;
export function askOpenClaw(
  command: string,
  gatewayCall: GatewayCall,
): Promise<string>;
```

## Fluxo principal

Lê histórico → rejeita sessão ocupada → envia `chat.send` com chave de
idempotência → consulta `chat.history` até a resposta final.

## Tratamento de erros e casos-limite

Rejeita JSON incompleto, sessão ativa, falta de `runId` ou timeout. A transcrição
não é incluída em logs.

## Exemplos

```ts
const response = await askOpenClaw(command, createGatewayCall());
```

## Dependências e integrações

Requer a CLI `openclaw` configurada para acessar o Gateway.
