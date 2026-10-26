# Puts the code-signing certificate into the store of the runner's account, where signtool finds
# it by thumbprint, and writes the thumbprint to the step's outputs (stage 7.6, docs/CODE-SIGNING.md).
# Only the two Windows signing jobs of .github/workflows/desktop-release.yml run it, and they run
# no code of the build; each removes the certificate again when it is done.
#
#   -Signing certificate   the release's certificate, from the environment variables
#                          WINDOWS_CERTIFICATE (a PKCS #12 file in base64) and
#                          WINDOWS_CERTIFICATE_PASSWORD (its password; leave it empty for a file
#                          without one), which the windows-signing environment's secrets hold
#   -Signing throwaway     a dry run's: a self-signed certificate made here, exported to a PKCS #12
#                          file with a random password and taken out of the store, then imported
#                          exactly as a release's is, so every dry run tries the release's path
#
# The key is imported without the flag that would let it be exported again, and the PKCS #12 file
# is deleted at once.
param(
  [Parameter(Mandatory)]
  [ValidateSet('certificate', 'throwaway')]
  [string] $Signing
)
$ErrorActionPreference = 'Stop'

if ($Signing -eq 'throwaway') {
  $made = New-SelfSignedCertificate -Type CodeSigningCert `
    -Subject 'CN=FXM release dry run (throwaway, untrusted)' `
    -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 3072 `
    -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(2)
  $password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
  $exported = Join-Path $env:RUNNER_TEMP 'throwaway.pfx'
  try {
    Export-PfxCertificate -Cert $made -FilePath $exported `
      -Password (ConvertTo-SecureString $password -AsPlainText -Force) | Out-Null
    $certificate = [Convert]::ToBase64String([IO.File]::ReadAllBytes($exported))
  } finally {
    Remove-Item -LiteralPath $exported -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($made.Thumbprint)" -DeleteKey
  }
} else {
  $certificate = "$env:WINDOWS_CERTIFICATE"
  $password = "$env:WINDOWS_CERTIFICATE_PASSWORD"
}

# From here on, the same for both.
if ($certificate.Trim() -eq '') { throw 'WINDOWS_CERTIFICATE is empty' }
$pfx = Join-Path $env:RUNNER_TEMP 'windows-signing.pfx'
[IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($certificate.Trim()))
try {
  $import = @{ FilePath = $pfx; CertStoreLocation = 'Cert:\CurrentUser\My' }
  if ($password -ne '') {
    $import.Password = ConvertTo-SecureString $password -AsPlainText -Force
  }
  $imported = Import-PfxCertificate @import |
    Where-Object { $_.HasPrivateKey } | Select-Object -First 1
} finally {
  Remove-Item -LiteralPath $pfx -Force
}
if (-not $imported) { throw 'WINDOWS_CERTIFICATE holds no certificate with its private key' }
"thumbprint=$($imported.Thumbprint)" >> $env:GITHUB_OUTPUT
