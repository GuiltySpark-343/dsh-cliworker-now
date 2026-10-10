# Read only Antigravity's own native Windows credential. Never emit its blob.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CwnAgyCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr value);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
  public static string Read() {
    IntPtr value;
    if (!CredRead("gemini:antigravity", 1, 0, out value)) {
      if (Marshal.GetLastWin32Error() == 1168) return null;
      throw new Exception("Credential store unavailable");
    }
    byte[] bytes = null;
    try {
      var credential = (Credential)Marshal.PtrToStructure(value, typeof(Credential));
      if (credential.CredentialBlobSize > 65536) throw new Exception("Invalid credential");
      bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      return bytes.Length > 1 && bytes[1] == 0
        ? new UnicodeEncoding(false, false, true).GetString(bytes)
        : new UTF8Encoding(false, true).GetString(bytes);
    } finally {
      if (bytes != null) Array.Clear(bytes, 0, bytes.Length);
      CredFree(value);
    }
  }
}
'@
  $raw = [CwnAgyCredential]::Read()
  if ($null -eq $raw) { @{ state = 'unconfigured' } | ConvertTo-Json -Compress; exit 0 }
  $account = $raw | ConvertFrom-Json
  $raw = $null
  if ($account.auth_method -ne 'consumer' -or -not $account.token) {
    @{ state = 'unknown' } | ConvertTo-Json -Compress; exit 0
  }
  $active = $false
  if ($account.token.access_token -is [string] -and $account.token.access_token.Trim()) {
    try { $active = [DateTimeOffset]::Parse($account.token.expiry) -gt [DateTimeOffset]::UtcNow } catch {}
  }
  $refreshable = $account.token.refresh_token -is [string] -and $account.token.refresh_token.Trim().Length -gt 0
  if (-not $active -and -not $refreshable) {
    @{ state = 'unauthenticated' } | ConvertTo-Json -Compress; exit 0
  }
  $result = @{ state = 'authenticated' }
  if ($account.id_token -is [string] -and $account.id_token.Length -le 32768 -and $account.id_token -match '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') {
    $encoded = $account.id_token.Split('.')[1].Replace('-','+').Replace('_','/')
    $encoded = $encoded.PadRight($encoded.Length + ((4 - $encoded.Length % 4) % 4), '=')
    $bytes = [Convert]::FromBase64String($encoded)
    try { $claims = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json }
    finally { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($claims.iss -in @('accounts.google.com', 'https://accounts.google.com') -and $claims.sub -is [string] -and $claims.sub -match '^[A-Za-z0-9_-]{6,128}$') {
      $hash = [Security.Cryptography.SHA256]::Create()
      $principal = [Text.Encoding]::UTF8.GetBytes('google:' + $claims.sub)
      try { $result.principalHash = ([BitConverter]::ToString($hash.ComputeHash($principal))).Replace('-','').ToLowerInvariant() }
      finally { [Array]::Clear($principal, 0, $principal.Length); $hash.Dispose() }
      if ($claims.email -is [string] -and $claims.email.Length -le 254 -and $claims.email -match '^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$') { $result.email = $claims.email }
    }
  }
  $account = $null; $claims = $null
  $result | ConvertTo-Json -Compress
} catch {
  # Neither exception strings nor credential fragments cross the process boundary.
  @{ state = 'unavailable' } | ConvertTo-Json -Compress
  exit 1
}
