import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// Fixed program, not interpolated shell code. Payloads and paths travel on stdin.
const WINDOWS_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
  $r = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Security
  if ($r.operation -eq 'protect' -or $r.operation -eq 'unprotect') {
    $bytes = [Convert]::FromBase64String($r.data)
    if ($r.operation -eq 'protect') {
      $out = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } else {
      $out = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    }
    [Console]::Out.Write([Convert]::ToBase64String($out))
  } elseif ($r.operation -eq 'permissions') {
    $item = Get-Item -Force -LiteralPath $r.path
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
    if ($item.PSIsContainer) { $acl = New-Object Security.AccessControl.DirectorySecurity } else { $acl = New-Object Security.AccessControl.FileSecurity }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($sid)
    foreach ($id in $allowed) {
      $identity = New-Object Security.Principal.SecurityIdentifier($id)
      if ($item.PSIsContainer) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      } else {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
      }
      $acl.AddAccessRule($rule)
    }
    $item.SetAccessControl($acl)
    $verified = $item.GetAccessControl()
    if (-not $verified.AreAccessRulesProtected) { throw 'Inherited ACL' }
    $rules = $verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
      if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $allowed -notcontains $rule.IdentityReference.Value) { throw 'Unexpected ACL' }
    }
    foreach ($id in $allowed) {
      if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq $id -and $_.FileSystemRights -eq 'FullControl' })) { throw 'Missing ACL' }
    }
    [Console]::Out.Write('ok')
  } else { throw 'Unknown operation' }
} catch { [Console]::Error.Write('Secure storage operation failed'); exit 1 }
`;

export function windowsSecureOperation(operation: "protect" | "unprotect" | "permissions", value: string): string {
  const program = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(program, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_HELPER], {
    input: JSON.stringify(operation === "permissions" ? { operation, path: value } : { operation, data: value }),
    encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Secure Windows storage failed. Run under the owning Windows account and check file permissions; plaintext fallback is disabled.");
  }
  return result.stdout.trim();
}

export function restrictPath(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("Secure storage requires a regular file or directory, not a link.");
  if (process.platform === "win32") windowsSecureOperation("permissions", path);
  else {
    if (info.uid !== process.getuid?.()) throw new Error("Secure storage must be owned by the current user.");
    const mode = info.isDirectory() ? 0o700 : 0o600;
    chmodSync(path, mode);
    if ((statSync(path).mode & 0o777) !== mode) throw new Error("Could not verify private file permissions.");
  }
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  restrictPath(path);
}

/** Atomically replace a file; the original survives any failure before rename. */
export function privateAtomicWrite(path: string, content: string): void {
  if (existsSync(path)) restrictPath(path);
  const temp = join(dirname(path), `.qb-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temp, "wx", 0o600);
    // Restrict before writing plaintext, including on Windows.
    restrictPath(temp);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (readFileSync(temp, "utf8") !== content) throw new Error("Secure file verification failed.");
    renameSync(temp, path);
    restrictPath(path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temp)) unlinkSync(temp);
  }
}
