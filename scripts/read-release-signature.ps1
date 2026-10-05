param([Parameter(Mandatory=$true)][string]$ArtifactPath)
$signature = Get-AuthenticodeSignature -LiteralPath $ArtifactPath
[pscustomobject]@{ status = $signature.Status.ToString(); signer = $signature.SignerCertificate.Subject } | ConvertTo-Json -Compress
