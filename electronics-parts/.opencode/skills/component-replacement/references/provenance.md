# Provenance contract

`VERIFIED`: evidence from a named source, with source type and a retrievable locator.
`INFERRED`: a conclusion that follows from cited verified facts; never use it for a required drop-in field.
`UNVERIFIED`: a model claim, incomplete source, or missing check.
`CONFLICT`: relevant reliable sources disagree.

Engineering source precedence is: manufacturer datasheet, manufacturer page, authorised distributor, distributor catalogue, aggregator. Procurement facts are verified by the current supplier offer and must retain `checked_at`.

Evidence status and comparison result are different fields. A verified mismatch is written as `VERIFIED — FAIL`; reserve `CONFLICT` for disagreement between sources. `PCB = VERIFIED` requires project evidence (`source_type: OTHER`, `source_name: PROJECT_SCHEMATIC` or `PROJECT_PCB_LAYOUT`) with a path/revision locator. A datasheet alone cannot prove compatibility with an existing PCB.

Pinout compatibility requires evidence for both the candidate and the reference. For switching-semiconductor parameters, retain the guarantee type (`typical`/`maximum`) and measurement conditions; a `maximum` value must not be directly compared with a `typical` value.

`EXACT_DROP_IN` and `QUALIFIED_DROP_IN` require verified package, pinout, PCB impact and every declared hard requirement. The evidence must identify source type, source URL or locator, and its check timestamp.
