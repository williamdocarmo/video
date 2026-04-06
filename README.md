# video

Aplicação de produção para criar, revisar, recuperar e publicar vídeos com UI web local, pipeline Google/Vertex, render local via Remotion e integração assistida com `agendador.online`.

URL principal:
- `http://127.0.0.1:3210`
- `https://video.vamostestar.online/`

Repo real:
- [/root/repo/videos-flux2](/root/repo/videos-flux2)
- alias local: [/home/william/claude-dinamico-test/repo](/home/william/claude-dinamico-test/repo)

Remoto Git:
- `origin = https://github.com/williamdocarmo/video.git`

## Estado atual

O app está em produção e já opera:
- criação de preview e heavy job
- geração de imagens com Google Vertex
- voz com Google Cloud Gemini-TTS
- timestamps / karaoke
- render final com Remotion
- biblioteca local de vídeos
- publicação/agendamento via `agendador.online`
- helper de upload manual para TikTok Web
- recovery parcial pela UI

O sistema está funcional, mas ainda **não** é um `video_case` canônico por revisão. Em jobs complexos com o mesmo `slug`, ainda pode haver estado stale em recovery/checklist. A UI atual já reduz bastante isso, mas a limitação continua importante.

## O que a aplicação faz

- cria preview de storyboard antes da render final
- corrige storyboard automaticamente quando a QA reprova algo técnico
- gera imagens por cena com Vertex
- audita a imagem localmente e com Gemini Vision
- sintetiza voz
- extrai timestamps
- renderiza MP4 final
- organiza biblioteca local e jobs falhados
- permite recovery parcial sem terminal
- publica/agende no `agendador.online`

## Arquitetura

Camadas principais:
- `web/`
  - backend Node da UI, fila, recovery, biblioteca, publicação e APIs
- `scripts/`
  - wrappers operacionais e geração de assets
- `video-engine/`
  - motor de storyboard, voz, timings, render e validação
- `.web-ui/`
  - persistência local da UI (`jobs.json`, biblioteca, drafts, metadados)
- `/root/postar`
  - export final por canal

Arquivos críticos:
- [web/server.mjs](/root/repo/videos-flux2/web/server.mjs)
- [web/public/app.js](/root/repo/videos-flux2/web/public/app.js)
- [web/public/index.html](/root/repo/videos-flux2/web/public/index.html)
- [scripts/foiumaideia.mjs](/root/repo/videos-flux2/scripts/foiumaideia.mjs)
- [scripts/generate-flux2-assets.mjs](/root/repo/videos-flux2/scripts/generate-flux2-assets.mjs)
- [video-engine/scripts/make-plan1-video.mjs](/root/repo/videos-flux2/video-engine/scripts/make-plan1-video.mjs)
- [video-engine/scripts/lib/llm-provider.mjs](/root/repo/videos-flux2/video-engine/scripts/lib/llm-provider.mjs)
- [video-engine/scripts/lib/tts.mjs](/root/repo/videos-flux2/video-engine/scripts/lib/tts.mjs)

## Fluxo da pipeline

1. O utilizador cria um job na UI.
2. O backend resolve canal, idioma, voz, modelo de imagem, estilo visual e estilo de roteiro.
3. O preview gera storyboard.
4. A QA textual valida a estrutura.
5. O heavy job gera assets visuais.
6. O motor gera voz e timestamps.
7. O Remotion renderiza o MP4 final.
8. O backend copia o output para `/root/postar/<canal>/`.
9. A biblioteca local atualiza o vídeo para revisão/publicação.

## Filosofia de QA

O sistema deixou de usar QA editorial como bloqueio forte.

Bloqueia:
- storyboard inválido
- off-topic claro
- `searchQuery` ou plano visual incompatível com a narração
- conteúdo técnico que quebra o pipeline

Vira aviso:
- hook fraco
- final fraco
- tom educativo demais
- baixa retenção
- CTA ruim
- pouca agressividade editorial

Regra prática:
- QA agora tenta agir como `coach`, não como polícia
- bloqueio só quando o vídeo ficaria quebrado ou claramente errado

## Canais e defaults

Canal `@foiumaideia`:
- idioma: `pt-BR`
- foco: short-form viral / história / tech / internet
- voz padrão: `Iapetus` ou outra definida explicitamente no job

Canal `@quiet2min`:
- idioma: `en-US`
- voz padrão: `Charon`
- tom: wellness / calm / comforting

Canal `@ate2min`:
- idioma: `pt-BR`
- voz padrão: `Iapetus`

## Estilos de roteiro expostos

- `Natural limpo`
- `Short-form nativo`
- `Wellness • Calmo reconfortante`
- `Wellness • Soltar o peso do dia`

## Vozes expostas na UI

Conjunto curado atual:
- `Iapetus`
- `Charon`
- `Kore`
- `Puck`
- `Sulafat`

Observação:
- o app usa Google Cloud TTS com modelo Gemini-TTS
- a UI já reduz o conjunto para vozes que fazem sentido para o fluxo atual

## Modelos de imagem expostos

A UI hoje mostra **só os modelos que já validaram acesso no projeto atual**:

| Modelo | Id | Preço de referência | Uso recomendado |
|---|---|---:|---|
| Imagen 4 Fast | `imagen-4.0-fast-generate-001` | `US$ 0,02 / imagem` | padrão atual, melhor custo/benefício |
| Gemini 2.5 Flash Image | `gemini-2.5-flash-image` | `~US$ 0,039 / imagem` | iteração/conversacional |
| Imagen 4 | `imagen-4.0-generate-001` | `US$ 0,04 / imagem` | qualidade equilibrada |
| Imagen 4 Ultra | `imagen-4.0-ultra-generate-001` | `US$ 0,06 / imagem` | qualidade máxima, mais caro |

Notas:
- `Imagen 4 Fast` virou o default da UI/backend
- os previews `Gemini 3.* image` não estão expostos porque o projeto atual não tem acesso
- o custo acima é referência operacional, não fatura oficial

## Resolução de geração

Geração base atual:
- vertical: `1080x1920`
- horizontal: `1920x1080`

Isso já foi elevado no gerador de assets para evitar nascer em `576x1024` e só depois upscale no render.

Arquivo:
- [scripts/generate-flux2-assets.mjs](/root/repo/videos-flux2/scripts/generate-flux2-assets.mjs)

## Música

Comportamento atual:
- se `Sem música de fundo` estiver marcado: sem trilha
- se estiver desmarcado e não houver `--music-file`: o pipeline sorteia uma faixa de
  - [/root/Documents/scripts/envato/music](/root/Documents/scripts/envato/music)

Notas importantes:
- a trilha é escolhida aleatoriamente
- isso hoje ainda não está 100% pinado por revisão do job
- para reprodutibilidade perfeita, o ideal futuro é persistir a música escolhida no metadata do run

## UI / abas

`Criar`
- formulário de criação
- preview
- status atual do job
- checklist
- ação recomendada

`Vídeos`
- biblioteca dos MP4 finais
- jobs falhados
- publicação/agendamento
- helper TikTok

`Layout`
- galeria real de estilos visuais
- comparação de modelos de imagem
- custo e comportamento visual por modelo

`Logs`
- acompanhamento tipo `tail -f`
- suporte operacional, não cockpit principal

## Recovery pela UI

A UI suporta recovery parcial. Ordem desejada:

1. `Regenerar cena X`
2. `Gerar áudio`
3. `Renderizar vídeo`
4. `Validar vídeo`

Outras ações:
- `Retomar a partir do ponto salvo`
- `Marcar como travado e liberar fila`
- `Refazer a partir do storyboard`

Regra operacional:
- a UI deve mostrar **só a próxima ação necessária**
- ela não deve empilhar botões desnecessários
- `force-fail` não deve virar fallback silencioso

### Recovery atual já corrigido

O que já foi tratado:
- jobs falhados de assets agora podem expor `Regenerar cena X` correto
- `generate` falhado deixa de herdar o preview como `sourceJob`
- `Regenerar cena` passa a confiar no backend para decidir a cena alvo, em vez de um número stale vindo da UI
- `scene-regenerate` respeita `autoContinueAfterSceneRepair`

## Fila e concorrência

Existem duas lanes:
- `preview`
- `heavy`

Comportamento:
- 1 preview pode rodar em paralelo com 1 heavy
- 2 heavy não rodam juntos
- 2 preview não rodam juntos
- jobs extra ficam enfileirados

## Operação do serviço

Serviço:
- `codex-video-ui.service`

Comandos:

```bash
systemctl status codex-video-ui.service
systemctl restart codex-video-ui.service
journalctl -u codex-video-ui.service -f
```

Antes de reiniciar:

```bash
python3 - <<'PY'
import urllib.request, json
with urllib.request.urlopen('http://127.0.0.1:3210/api/jobs') as r:
    data=json.load(r)
print({k:data.get(k) for k in ['activeJobId','activePreviewJobId','activeHeavyJobId','queueLength']})
PY
```

Só reiniciar com segurança quando:
- `activeJobId = null`
- `activePreviewJobId = null`
- `activeHeavyJobId = null`
- `queueLength = 0`

Observação:
- reinício com jobs vivos pode marcar jobs `queued/running` como falhados
- o estado da UI e do disco pode ficar inconsistente até o próximo recovery

## GCloud / Vertex / Billing

Projeto atual:
- `project-79978184-3df0-40b2-b9f`

Location:
- `us-central1`

Credencial atual usada pelo app:
- `/home/william/claude-dinamico-test/gcp-ate.json`

`gcloud` já foi instalado e autenticado com a service account do projeto.

Serviços já habilitados:
- `aiplatform.googleapis.com`
- `texttospeech.googleapis.com`
- `cloudbilling.googleapis.com`
- `logging.googleapis.com`
- `monitoring.googleapis.com`
- `bigquery.googleapis.com`
- `bigquerydatatransfer.googleapis.com`

Billing:
- billing account ativa: `billingAccounts/010548-6B432A-4593A9`

Dataset de export de billing já criado:
- `project-79978184-3df0-40b2-b9f:billing_export`

Passo ainda manual:
- ativar o Cloud Billing Export no console
- URL: `https://console.cloud.google.com/billing/export?project=project-79978184-3df0-40b2-b9f`

Depois disso, o custo real pode ser consultado via BigQuery.

## Estimativa de custo já encontrada

Estimativa local consolidada a partir de `gemini-usage.json`:
- total observado: `~US$ 0,7718`

Quebra local encontrada:
- `gemini-2.5-flash`: `~US$ 0,3367`
- `gemini-2.5-flash-image`: `~US$ 0,4351`

Importante:
- isto **não** é a fatura oficial do GCP
- é só estimativa local do app
- TTS ainda não está consolidado nesse cálculo local

## TikTok

O sistema hoje oferece:
- helper local de upload
- cópia de descrição
- thumbnail local
- MP4 pronto

Limite atual:
- não existe integração oficial de publish do TikTok implementada
- o helper é semi-manual

## Galeria / Layout

O `Layout` hoje não é só “estilo visual”.
Também serve para:
- comparar presets visuais
- comparar modelos de imagem com prompt real
- ver custo/qualidade por modelo

Scripts relevantes:
- [scripts/generate-style-gallery.mjs](/root/repo/videos-flux2/scripts/generate-style-gallery.mjs)
- [web/public/style-gallery/index.html](/root/repo/videos-flux2/web/public/style-gallery/index.html)

## Comandos úteis

```bash
# UI
npm run web

# wrapper principal
node scripts/foiumaideia.mjs --title "CHAMARAM O GPS DE PIADA"

# rerender de voz
node video-engine/scripts/rerender-voice.mjs --slug 2026-04-05-exemplo --voice Charon

# validação manual
node video-engine/scripts/validate-run.mjs --slug 2026-04-05-exemplo
```

## Mudanças recentes importantes

- image model selector real na UI
- default de imagem trocado para `Imagen 4 Fast`
- resolução de geração elevada para `1080x1920` / `1920x1080`
- layout gallery com comparação real de modelos
- TTS pacing mais conservador para reduzir `429`
- checklist e ação recomendada no cockpit
- `force-fail` mata processo real
- `scene-regenerate` com rota de recovery parcial
- wrapper deixou de short-circuitar por export final já existente
- wrapper agora só reaproveita preview quando `--reuse-preview` for explícito
- `failed panel` da UI passou a refletir melhor a recomendação real

## Bugs conhecidos e limites atuais

### 1. `same slug` ainda é fonte de risco

Mesmo com várias correções, o sistema ainda compartilha namespace de artefatos por `slug`:
- `runs/<slug>`
- `assets/envato/<slug>`
- `out/<slug>.mp4`

Risco:
- um job pode parecer mais saudável ou mais completo por causa de artefato de outra tentativa do mesmo `slug`

Mitigação atual:
- freshness checks
- `artifactEpochAt`
- recovery mais conservador
- uso do backend como autoridade da cena faltante

Correção estrutural ainda pendente:
- `video_case` + `job_attempt` canônicos com revisão própria

### 2. `scene-regenerate` ainda usa metadata global do slug

Risco:
- manifests e relatórios do slug podem refletir uma partial run

Estado:
- ainda não foi completamente isolado por cena/revisão

### 3. Billing real ainda depende do export para BigQuery

Hoje existe:
- billing ativo
- dataset criado

Mas falta:
- export oficial ativado no console

### 4. `/tmp` pode voltar a saturar

Já houve falha real de render por `/tmp` cheio, não por falta de espaço no disco principal.

Pontos de atenção:
- bundles do Remotion
- caches temporários
- arquivos grandes esquecidos em `/tmp`

### 5. Quotas `429`

Ainda podem acontecer em:
- Vertex image generation
- Gemini Vision
- Gemini-TTS / Google Cloud TTS

Mitigação:
- pacing mais conservador
- retries
- observação do log

## Próximas ondas recomendadas

Para deixar o sistema realmente autônomo sem depender de contexto manual:

1. criar `video_case` canônico
2. separar `job_attempt` de `video_case`
3. invalidar `audio/render/qa` por revisão real
4. persistir provenance por etapa
5. tornar `Vídeos` o cockpit primário e `Logs` só suporte

## Fonte de verdade ao reabrir noutro terminal

Se reabrir o projeto sem contexto anterior, usar este `README.md` como ponto de partida.

Para validar rapidamente o estado:

```bash
python3 - <<'PY'
import urllib.request, json
with urllib.request.urlopen('http://127.0.0.1:3210/api/jobs') as r:
    jobs=json.load(r)
with urllib.request.urlopen('http://127.0.0.1:3210/api/videos') as r:
    videos=json.load(r)
print({
  'activeJobId': jobs.get('activeJobId'),
  'queueLength': jobs.get('queueLength'),
  'jobs': len(jobs.get('jobs', [])),
  'videos': len(videos.get('videos', [])),
  'failedJobs': len(videos.get('failedJobs', []))
})
PY
```
