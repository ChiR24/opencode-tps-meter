import type { BunPlugin } from "bun";
import path from "path";

async function build(): Promise<void> {
  const srcDir = path.join(import.meta.dir, "src");
  const outDir = path.join(import.meta.dir, "dist");

  // Build ESM output
  const esmResult = await Bun.build({
    entrypoints: [path.join(srcDir, "index.ts")],
    outdir: outDir,
    format: "esm",
    naming: {
      entry: "[name].mjs",
    },
    target: "node",
    external: ["@opencode-ai/plugin", "zod"],
    minify: false,
    splitting: false,
  });

  if (!esmResult.success) {
    console.error("ESM build failed:", esmResult.logs);
    process.exit(1);
  }

  // Build CommonJS output
  const cjsResult = await Bun.build({
    entrypoints: [path.join(srcDir, "index.ts")],
    outdir: outDir,
    format: "cjs",
    naming: {
      entry: "[name].js",
    },
    target: "node",
    external: ["@opencode-ai/plugin", "zod"],
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
  console.log("  - dist/index.d.ts (TypeScript declarations)");
}

// Run build if this file is executed directly
if (import.meta.main) {
  build().catch((error) => {
    console.error("Build failed:", error);
    process.exit(1);
  });
}

export { build };
