#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./script/generate.ts`
await $`git diff --exit-code -- packages/sdk/openapi.json packages/sdk/js/src/gen packages/sdk/js/src/v2`
