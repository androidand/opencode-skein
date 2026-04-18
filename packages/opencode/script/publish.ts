#!/usr/bin/env bun

import { $ } from "bun"
import { Effect } from "effect"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const published = (name: string, version: string) =>
  Effect.promise(() => $`npm view ${name}@${version} version`.nothrow()).pipe(
    Effect.map((result) => result.exitCode === 0),
  )

const sha256 = (path: string) =>
  Effect.promise(() => $`sha256sum ${path} | cut -d' ' -f1`.text()).pipe(Effect.map((text) => text.trim()))

const publishPackage = (dir: string, name: string, version: string) =>
  Effect.gen(function* () {
    if (yield* published(name, version)) {
      console.log(`already published ${name}@${version}`)
      return
    }
    if (process.platform !== "win32") yield* Effect.promise(() => $`chmod -R 755 .`.cwd(dir))
    yield* Effect.promise(() => $`bun pm pack`.cwd(dir))
    yield* Effect.promise(() => $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir))
  })

const binaryVersion = (value: unknown) => {
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "version" in value &&
    typeof value.version === "string"
  ) {
    return value
  }
  throw new Error("invalid dist package manifest")
}

const ensureVersion = (value: unknown) => {
  if (typeof value === "string") return value
  throw new Error("missing dist package version")
}

const program = Effect.gen(function* () {
  const binaries: Record<string, string> = Object.fromEntries(
    yield* Effect.promise(async () =>
      Array.fromAsync(new Bun.Glob("*/package.json").scan({ cwd: "./dist" }), async (filepath) => {
        const current = binaryVersion(await Bun.file(`./dist/${filepath}`).json())
        return [current.name, current.version] as const
      }),
    ),
  )
  console.log("binaries", binaries)

  const version = ensureVersion(Object.values(binaries)[0])

  yield* Effect.promise(() => $`mkdir -p ./dist/${pkg.name}`)
  yield* Effect.promise(() => $`cp -r ./bin ./dist/${pkg.name}/bin`)
  yield* Effect.promise(() => $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`)
  yield* Effect.promise(async () =>
    Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text()),
  )
  yield* Effect.promise(() =>
    Bun.write(
      `./dist/${pkg.name}/package.json`,
      JSON.stringify(
        {
          name: pkg.name + "-ai",
          bin: { [pkg.name]: `./bin/${pkg.name}` },
          scripts: { postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs" },
          version,
          license: pkg.license,
          optionalDependencies: binaries,
        },
        null,
        2,
      ),
    ),
  )

  yield* Effect.all(Object.entries(binaries).map(([name, version]) => publishPackage(`./dist/${name}`, name, version)))
  yield* publishPackage(`./dist/${pkg.name}`, `${pkg.name}-ai`, version)

  const image = "ghcr.io/anomalyco/opencode"
  const tags = [`${image}:${version}`, `${image}:${Script.channel}`]
  yield* Effect.promise(
    () => $`docker buildx build --platform linux/amd64,linux/arm64 ${tags.flatMap((t) => ["-t", t])} --push .`,
  )

  if (Script.preview) return

  const [arm64Sha, x64Sha, macX64Sha, macArm64Sha] = yield* Effect.all([
    sha256("./dist/opencode-linux-arm64.tar.gz"),
    sha256("./dist/opencode-linux-x64.tar.gz"),
    sha256("./dist/opencode-darwin-x64.zip"),
    sha256("./dist/opencode-darwin-arm64.zip"),
  ])
  const [pkgver, subver = ""] = Script.version.split(/(-.*)/, 2)

  const binaryPkgbuild = [
    "# Maintainer: dax",
    "# Maintainer: adam",
    "",
    "pkgname='opencode-bin'",
    `pkgver=${pkgver}`,
    `_subver=${subver}`,
    "options=('!debug' '!strip')",
    "pkgrel=1",
    "pkgdesc='The AI coding agent built for the terminal.'",
    "url='https://github.com/anomalyco/opencode'",
    "arch=('aarch64' 'x86_64')",
    "license=('MIT')",
    "provides=('opencode')",
    "conflicts=('opencode')",
    "depends=('ripgrep')",
    "",
    `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::https://github.com/anomalyco/opencode/releases/download/v\${pkgver}\${_subver}/opencode-linux-arm64.tar.gz")`,
    `sha256sums_aarch64=('${arm64Sha}')`,
    `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::https://github.com/anomalyco/opencode/releases/download/v\${pkgver}\${_subver}/opencode-linux-x64.tar.gz")`,
    `sha256sums_x86_64=('${x64Sha}')`,
    "",
    "package() {",
    '  install -Dm755 ./opencode "${pkgdir}/usr/bin/opencode"',
    "}",
    "",
  ].join("\n")

  yield* Effect.promise(async () => {
    for (let i = 0; i < 30; i++) {
      try {
        await $`rm -rf ./dist/aur-opencode-bin`
        await $`git clone ssh://aur@aur.archlinux.org/opencode-bin.git ./dist/aur-opencode-bin`
        await $`cd ./dist/aur-opencode-bin && git checkout master`
        await Bun.write(`./dist/aur-opencode-bin/PKGBUILD`, binaryPkgbuild)
        await $`cd ./dist/aur-opencode-bin && makepkg --printsrcinfo > .SRCINFO`
        await $`cd ./dist/aur-opencode-bin && git add PKGBUILD .SRCINFO`
        if ((await $`cd ./dist/aur-opencode-bin && git diff --cached --quiet`.nothrow()).exitCode === 0) return
        await $`cd ./dist/aur-opencode-bin && git commit -m "Update to v${Script.version}"`
        await $`cd ./dist/aur-opencode-bin && git push`
        return
      } catch {}
    }
  })

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    console.error("GITHUB_TOKEN is required to update homebrew tap")
    process.exit(1)
  }

  const homebrewFormula = [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "# This file was generated by GoReleaser. DO NOT EDIT.",
    "class Opencode < Formula",
    '  desc "The AI coding agent built for the terminal."',
    '  homepage "https://github.com/anomalyco/opencode"',
    `  version "${Script.version.split("-")[0]}"`,
    "",
    '  depends_on "ripgrep"',
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/anomalyco/opencode/releases/download/v${Script.version}/opencode-darwin-x64.zip"`,
    `      sha256 "${macX64Sha}"`,
    "",
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/anomalyco/opencode/releases/download/v${Script.version}/opencode-darwin-arm64.zip"`,
    `      sha256 "${macArm64Sha}"`,
    "",
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/anomalyco/opencode/releases/download/v${Script.version}/opencode-linux-x64.tar.gz"`,
    `      sha256 "${x64Sha}"`,
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/anomalyco/opencode/releases/download/v${Script.version}/opencode-linux-arm64.tar.gz"`,
    `      sha256 "${arm64Sha}"`,
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "  end",
    "end",
    "",
    "",
  ].join("\n")

  yield* Effect.promise(async () => {
    await $`rm -rf ./dist/homebrew-tap`
    await $`git clone https://x-access-token:${token}@github.com/anomalyco/homebrew-tap.git ./dist/homebrew-tap`
    await Bun.write("./dist/homebrew-tap/opencode.rb", homebrewFormula)
    await $`cd ./dist/homebrew-tap && git add opencode.rb`
    if ((await $`cd ./dist/homebrew-tap && git diff --cached --quiet`.nothrow()).exitCode === 0) return
    await $`cd ./dist/homebrew-tap && git commit -m "Update to v${Script.version}"`
    await $`cd ./dist/homebrew-tap && git push`
  })
})

await Effect.runPromise(program)
