# Read-only, bounded native owner/DACL projection. Paths arrive only through JSON stdin.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $raw = [Console]::In.ReadToEnd()
  if ($raw.Length -gt 65536) { throw 'input limit' }
  $request = $raw | ConvertFrom-Json
  if ($request.version -ne 1 -or @($request.paths).Count -lt 1 -or @($request.paths).Count -gt 16) { throw 'path limit' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $items = @()
  foreach ($path in @($request.paths)) {
    if ($path -isnot [string] -or $path.Length -gt 32767 -or $path -notmatch '^[A-Za-z]:\\' -or $path -match '[\x00-\x1f]') { throw 'path form' }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse path' }
    $acl = Get-Acl -LiteralPath $path
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    $aces = @()
    if ($null -ne $descriptor.DiscretionaryAcl) {
      foreach ($ace in $descriptor.DiscretionaryAcl) {
        if ($ace -isnot [Security.AccessControl.CommonAce]) { throw 'unsupported ace' }
        $aces += @{ type = [int]$ace.AceType; flags = [int]$ace.AceFlags; mask = [long]$ace.AccessMask; sid = $ace.SecurityIdentifier.Value }
      }
    }
    $items += @{ path = $path; owner = $descriptor.Owner.Value; control = [int]$descriptor.ControlFlags;
      nullDacl = ($null -eq $descriptor.DiscretionaryAcl); aces = @($aces);
      descriptor = [Convert]::ToBase64String($acl.GetSecurityDescriptorBinaryForm()) }
  }
  [Console]::Out.Write((@{ version = 1; currentSid = $sid; items = @($items) } | ConvertTo-Json -Depth 8 -Compress))
} catch {
  # Never quote paths, account labels or native error diagnostics to the caller.
  [Console]::Error.Write('Native file privacy could not be verified')
  exit 21
}
