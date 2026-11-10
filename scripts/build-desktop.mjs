import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";

// GUI-launched shells may omit an already installed Homebrew/rustup toolchain.
const rustDirectories = [
  join(homedir(), ".cargo", "bin"),
  "/opt/homebrew/opt/rustup/bin",
  "/usr/local/opt/rustup/bin",
].filter(directory => existsSync(join(directory, process.platform === "win32" ? "rustc.exe" : "rustc")));
const env = { ...process.env, PATH: [...rustDirectories, process.env.PATH ?? ""].join(delimiter) };
const extra = process.argv.slice(2);
const nativeDmg = process.platform === "darwin" && extra.length === 0;

function run(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? accept() : reject(new Error(`${command} exited with ${code}`)));
  });
}

try {
  // Avoid Finder/AppleScript layout automation, which can leave a busy build volume.
  await run(process.platform === "win32" ? "npm.cmd" : "npm", [
    "--prefix", "apps/desktop", "run", "build",
    ...((nativeDmg || extra.length) ? ["--", ...(nativeDmg ? ["--bundles", "app"] : extra)] : []),
  ]);
  if (nativeDmg) {
    const config = JSON.parse(readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
    const bundle = resolve("apps/desktop/src-tauri/target/release/bundle");
    const stage = mkdtempSync(join(tmpdir(), "lingxi-dmg-stage-"));
    const app = join(bundle, "macos", `${config.productName}.app`);
    await run("codesign", ["--verify", "--deep", "--strict", app]);
    await run("ditto", [app, join(stage, `${config.productName}.app`)]);
    symlinkSync("/Applications", join(stage, "Applications"));
    mkdirSync(join(bundle, "dmg"), { recursive: true });
    const arch = process.arch === "arm64" ? "aarch64" : process.arch;
    const dmg = join(bundle, "dmg", `${config.productName}_${config.version}_${arch}.dmg`);
    await run("hdiutil", ["create", "-volname", config.productName, "-srcfolder", stage, "-format", "UDZO", "-ov", dmg]);
    await run("hdiutil", ["verify", dmg]);
    console.log(`Built installer: ${dmg}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
