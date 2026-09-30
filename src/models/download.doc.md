# Model Download

## Visão geral

Prepara o cache Whisper e os arquivos locais do Kokoro exigidos pelo worker.

## Responsabilidades

- Permitir download explícito do Whisper pelo Transformers.js.
- Baixar os dois arquivos Kokoro por HTTPS para o diretório local de modelos.
- Gravar arquivos incompletos em nomes temporários e renomeá-los ao concluir.

## Entradas e saídas

- Entrada: diretório de dados e conectividade HTTPS.
- Saída: cache Whisper e arquivos ONNX/vozes do Kokoro.

## API / Assinatura

```ts
export function downloadModels(): Promise<void>;
```

## Fluxo principal

Cria os diretórios privados → prepara Whisper → baixa apenas arquivos Kokoro
ausentes → publica cada download por renomeação atômica.

## Tratamento de erros e casos-limite

HTTP não-2xx, respostas vazias ou falha de escrita interrompem o processo e
removem o arquivo temporário.

## Exemplos

Execute `npm run models:download` antes de habilitar `HF_HUB_OFFLINE=1`.

## Dependências e integrações

Usa `@huggingface/transformers`, `fetch` do Node.js e os arquivos públicos do
release `model-files-v1.0` de `kokoro-onnx`.
