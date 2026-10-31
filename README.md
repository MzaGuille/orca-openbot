# orca-openbot
Puente entre Pi (Gentle Shell en Orca) y OpenBot: avisa cuando un agente pregunta, termina o falla

## Consentimiento de revisión

En modo RPC (el de Orca) Pi no dibuja el consentimiento de `gentle_review`: el sobre
`consent_required` llega como resultado de la herramienta y el turno termina explicándolo.
El puente lo detecta en `tool_execution_end` de `gentle_review` (JSON tipado, no el texto del
modelo) y el siguiente `agent_settled` sale como pregunta:

- señal `pi-review-consent`, `attention_kind` `question`, evento `orca.pane.question`;
- `summary`: `<headline> (revisión, riesgo <risk_level>, <changed_files> archivos)`;
- `question.kind = "review-consent"`, `question.text` = el headline y
  `question.options = ["granted: <invocación>", "declined: <invocación>"]`.

Para contestar se corre la invocación elegida en una shell con
`GENTLE_PI_REVIEW_RELAY_CONTRACT=gentle-pi.review-relay/v1`:

```sh
GENTLE_PI_REVIEW_RELAY_CONTRACT=gentle-pi.review-relay/v1 gentle-ai review start … --consent granted
```

`orca-openbot send` no alcanza: el consentimiento no se contesta por el bridge. Solo se ofrece
una invocación que empiece con `gentle-ai review start ` y termine en su propio
`--consent <respuesta>`; un sobre que no cumple se descarta y el turno sale como `done`.
Un `gentle_review` posterior (`start`, `answer-consent`) sin sobre da el consentimiento por resuelto.
El bridge escribe el mismo dato en el `done` (`detail.consent`).
