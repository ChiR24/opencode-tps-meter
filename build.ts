import solidTransformPlugin from "@opentui/solid/bun-plugin";
import path from "path";

async function build(): Promise<void> {
  const srcDir = path.join(import.meta.dir, "src");
  const outDir = path.join(import.meta.dir, "dist");
  const entrypoints = [
    path.join(srcDir, "index.ts"),
    path.join(srcDir, "tui.tsx"),
    // Dedicated v2 (opencode2) entries. The v1 entries above also carry the v2 shape,
    // but these give v2 users an unambiguous target with no callable v1 export.
    path.join(srcDir, "v2", "server.ts"),
    path.join(srcDir, "v2", "tui.tsx"),
  ];
  const external = [
    "@opencode-ai/plugin",
    "@opencode-ai/plugin/tui",
    "@opencode-ai/plugin/v1",
    "@opencode-ai/plugin/v1/tui",
    "@opentui/core",
    "@opentui/keymap",
    "@opentui/solid",
    "@opentui/solid/jsx-runtime",
    "solid-js",
    "solid-js/web",
    "zod",
  ];

  // Build ESM output
  const esmResult = await Bun.build({
    entrypoints,
    outdir: outDir,
    root: srcDir,
    format: "esm",
    naming: {
      // [dir] keeps src/v2/* under dist/v2/*, so v2/tui does not collide with tui.
      entry: "[dir]/[name].mjs",
    },
    target: "node",
    external,
    plugins: [solidTransformPlugin],
    minify: false,
    splitting: false,
  });

  if (!esmResult.success) {
    console.error("ESM build failed:", esmResult.logs);
    process.exit(1);
  }

  // Build CommonJS output
  const cjsResult = await Bun.build({
    entrypoints,
    outdir: outDir,
    root: srcDir,
    format: "cjs",
    naming: {
      entry: "[dir]/[name].js",
    },
    target: "node",
    external,
    plugins: [solidTransformPlugin],
    minify: false,
    splitting: false,
  });

  if (!cjsResult.success) {
    console.error("CJS build failed:", cjsResult.logs);
    process.exit(1);
  }

  // Fix CJS export for OpenCode compatibility
  // OpenCode expects the plugin function directly as module.exports
  const cjsPath = path.join(outDir, "index.js");
  let cjsContent = await Bun.file(cjsPath).text();
  
  // Remove the original CommonJS export line
  cjsContent = cjsContent.replace(
    /module\.exports = __toCommonJS\(exports_src\);\n?/,
    ""
  );
  
  // Append the export at the end of the file
  // This ensures TpsMeterPlugin is defined before we export it
  cjsContent += `\n// OpenCode compatibility: export plugin function\n`;
  cjsContent += `module.exports = exports_src.default;\n`;
  cjsContent += `module.exports.default = exports_src.default;\n`;
  cjsContent += `Object.defineProperty(module.exports, "__esModule", { value: true });\n`;
  
  await Bun.write(cjsPath, cjsContent);
  console.log("✓ Fixed CJS exports for OpenCode compatibility");

  // Create a package.json in dist to force CommonJS mode for .js files
  // This is needed because the root package.json has "type": "module"
  const distPkgPath = path.join(outDir, "package.json");
  await Bun.write(distPkgPath, JSON.stringify({ type: "commonjs" }, null, 2));
  console.log("✓ Created dist/package.json with type: commonjs");

  // Generate type declarations using tsc
  const tscProcess = Bun.spawn(["bunx", "tsc", "--emitDeclarationOnly", "--declaration", "--outDir", "dist"], {
    cwd: import.meta.dir,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await tscProcess.exited;
  
  if (exitCode !== 0) {
    console.error("Type declaration generation failed");
    process.exit(1);
  }

  console.log("✓ Build completed successfully");
  console.log("  - dist/index.mjs (ESM)");
  console.log("  - dist/index.js (CommonJS - OpenCode compatible)");
  console.log("  - dist/tui.mjs (TUI plugin)");
  console.log("  - dist/tui.js (internal CommonJS TUI artifact, not package-exported)");
  console.log("  - dist/v2/server.mjs (opencode2 server plugin)");
  console.log("  - dist/v2/tui.mjs (opencode2 TUI plugin)");
  console.log("  - dist/index.d.ts (TypeScript declarations)");
  console.log("  - dist/tui.d.ts (TUI declarations)");
}

// Run build if this file is executed directly
if (import.meta.main) {
  build().catch((error) => {
    console.error("Build failed:", error);
    process.exit(1);
  });
}

export { build };
