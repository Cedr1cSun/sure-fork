# LID fixtures

`firered_lid_smoke/` is the approved two-language smoke fixture for spoken
language identification. It uses one English and one Mandarin LibriSpeech
utterance, with canonical language/dialect labels in `gt.jsonl`.

Copy selected samples into a model-local fixture before onboarding:

```text
sure/models/<model>/fixture/lid/
```

The fixture validates the `audio_path -> {label: language_code}` contract. It
does not claim benchmark-level LID accuracy; formal scoring uses the pinned
evaluation route:

```text
lid.any.accuracy.lid_label_canonical_v1.classify_v1
```
