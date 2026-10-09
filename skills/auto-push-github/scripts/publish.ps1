[CmdletBinding()]
param(
    [string]$Remote = "",
    [string]$Message = "chore: publish completed project",
    [string]$TargetBranch = "",
    [string[]]$Paths = @(),
    [switch]$AllowSensitive,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$env:GIT_TERMINAL_PROMPT = "0"
$env:GCM_INTERACTIVE = "Never"

function Invoke-GitChecked {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & git @Arguments
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $exitCode."
    }
}

function Get-GitLines {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $lines = & git @Arguments 2>$null
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $exitCode."
    }

    return @($lines)
}

function Get-CandidatePaths {
    param(
        [string[]]$Paths = @()
    )

    $pathList = New-Object System.Collections.Generic.List[string]
    $pathArguments = @()
    if ($Paths.Count -gt 0) {
        $pathArguments = @("--") + $Paths
    }

    foreach ($arguments in @(
        (@("ls-files", "--others", "--exclude-standard") + $pathArguments),
        (@("diff", "--name-only") + $pathArguments),
        (@("diff", "--cached", "--name-only") + $pathArguments)
    )) {
        foreach ($line in @(Get-GitLines -Arguments $arguments)) {
            if (-not [string]::IsNullOrWhiteSpace($line)) {
                $pathList.Add($line.Trim())
            }
        }
    }

    return @($pathList | Sort-Object -Unique)
}

function Test-SensitivePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $normalized = $Path -replace "\\", "/"
    $leaf = $normalized.Split("/")[-1]

    if ($leaf -match "^(?i)\.env\.(example|sample|template)$") {
        return $false
    }

    if ($leaf -match "^(?i)(\.env|\.envrc|\.npmrc|\.pypirc|id_rsa|id_ed25519|credentials\.json|secrets?\.json)$") {
        return $true
    }

    if ($leaf -match "^(?i).*(\.pem|\.key|\.pfx|\.p12|\.jks|\.keystore|\.token|\.secret)$") {
        return $true
    }

    if ($normalized -match "(?i)(^|/)(\.ssh|\.aws)(/|$)") {
        return $true
    }

    return $false
}

try {
    $repoRootOutput = & git rev-parse --show-toplevel 2>$null
    $repoRootExit = $LASTEXITCODE
    if ($repoRootExit -ne 0 -or [string]::IsNullOrWhiteSpace(($repoRootOutput | Select-Object -First 1))) {
        throw "This directory is not inside a Git repository. Initialize the repository and add a GitHub remote first."
    }

    $repoRoot = ($repoRootOutput | Select-Object -First 1).Trim()
    Set-Location -LiteralPath $repoRoot

    if ($Paths.Count -gt 0) {
        $repoRootNormalized = $repoRoot -replace "/", "\"
        $rootPrefix = $repoRootNormalized.TrimEnd([char[]]@("\")) + [System.IO.Path]::DirectorySeparatorChar
        foreach ($path in $Paths) {
            if ([string]::IsNullOrWhiteSpace($path) -or [System.IO.Path]::IsPathRooted($path)) {
                throw "Every -Paths value must be a non-empty path relative to the repository root."
            }

            $fullPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $path))
            $fullPathNormalized = $fullPath -replace "/", "\"
            if (-not ($fullPathNormalized.Equals($repoRootNormalized, [System.StringComparison]::OrdinalIgnoreCase) -or
                    $fullPathNormalized.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase))) {
                throw "The path '$path' is outside the repository root."
            }
        }
    }

    $branchOutput = & git symbolic-ref --quiet --short HEAD 2>$null
    $branchExit = $LASTEXITCODE
    if ($branchExit -ne 0 -or [string]::IsNullOrWhiteSpace(($branchOutput | Select-Object -First 1))) {
        throw "The repository is in detached HEAD state. Check out a branch before publishing."
    }
    $branch = ($branchOutput | Select-Object -First 1).Trim()

    if (-not [string]::IsNullOrWhiteSpace($TargetBranch)) {
        $targetBranchOutput = & git check-ref-format --branch $TargetBranch 2>$null
        $targetBranchExit = $LASTEXITCODE
        if ($targetBranchExit -ne 0) {
            throw "TargetBranch '$TargetBranch' is not a valid branch name."
        }
    }

    $remoteNames = @(Get-GitLines -Arguments @("remote"))
    if ($remoteNames.Count -eq 0) {
        throw "No Git remote is configured. Add an existing GitHub repository as a remote first."
    }

    if (-not [string]::IsNullOrWhiteSpace($Remote)) {
        if ($remoteNames -notcontains $Remote) {
            throw "Remote '$Remote' does not exist. Available remotes: $($remoteNames -join ', ')."
        }
        $selectedRemote = $Remote
    } else {
        $selectedRemote = $null

        if ($remoteNames -contains "origin") {
            $selectedRemote = "origin"
        }

        if ([string]::IsNullOrWhiteSpace($selectedRemote)) {
            foreach ($candidate in $remoteNames) {
                $candidateUrlOutput = & git config --get "remote.$candidate.url" 2>$null
                $candidateUrlExit = $LASTEXITCODE
                $candidateUrl = ($candidateUrlOutput | Select-Object -First 1)
                if ($candidateUrlExit -eq 0 -and $candidateUrl -match "github\.com") {
                    $selectedRemote = $candidate
                    break
                }
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($selectedRemote)) {
        throw "No GitHub remote was found. Available remotes: $($remoteNames -join ', ')."
    }

    $remoteUrlOutput = & git config --get "remote.$selectedRemote.url" 2>$null
    $remoteUrlExit = $LASTEXITCODE
    $remoteUrl = ($remoteUrlOutput | Select-Object -First 1)
    if ($remoteUrlExit -ne 0 -or [string]::IsNullOrWhiteSpace($remoteUrl)) {
        throw "Could not read the URL for remote '$selectedRemote'."
    }
    $remoteUrl = $remoteUrl.Trim()

    if ($remoteUrl -notmatch "github\.com") {
        throw "Remote '$selectedRemote' is not a github.com remote: $remoteUrl"
    }

    $preStagedPaths = @(Get-GitLines -Arguments @("diff", "--cached", "--name-only"))
    if ($preStagedPaths.Count -gt 0) {
        throw "The Git index already contains staged changes. Commit or unstage them before using this helper."
    }

    $candidatePaths = @(Get-CandidatePaths -Paths $Paths)
    $sensitivePaths = @($candidatePaths | Where-Object { Test-SensitivePath -Path $_ })

    if ($sensitivePaths.Count -gt 0 -and -not $AllowSensitive) {
        $displayPaths = ($sensitivePaths | ForEach-Object { "  $_" }) -join [Environment]::NewLine
        throw "Secret-like files were detected and were not uploaded:`n$displayPaths`nAdd them to .gitignore or pass -AllowSensitive only after explicit confirmation."
    }

    Write-Host "Repository: $repoRoot"
    Write-Host "Remote:     $selectedRemote ($remoteUrl)"
    Write-Host "Branch:     $branch"
    if (-not [string]::IsNullOrWhiteSpace($TargetBranch)) {
        Write-Host "Target:     $TargetBranch"
    }

    if ($DryRun) {
        if ($candidatePaths.Count -eq 0) {
            Write-Host "Changes:    none"
        } else {
            Write-Host "Changes:"
            $candidatePaths | ForEach-Object { Write-Host "  $_" }
        }
        Write-Host "Dry run complete. Nothing was staged, committed, or pushed."
        exit 0
    }

    $stageArguments = @("add", "-A", "--")
    if ($Paths.Count -gt 0) {
        $stageArguments += $Paths
    } else {
        $stageArguments += "."
    }
    Invoke-GitChecked -Arguments $stageArguments

    $stagedPaths = @(Get-GitLines -Arguments @("diff", "--cached", "--name-only"))
    $commitHash = $null

    if ($stagedPaths.Count -gt 0) {
        Invoke-GitChecked -Arguments @("commit", "-m", $Message)
        $commitHashOutput = & git rev-parse --short HEAD
        $commitHashExit = $LASTEXITCODE
        if ($commitHashExit -ne 0) {
            throw "Could not read the new commit hash."
        }
        $commitHash = ($commitHashOutput | Select-Object -First 1).Trim()
        Write-Host "Commit:     $commitHash"
    } else {
        Write-Host "Changes:    none to commit"
    }

    if (-not [string]::IsNullOrWhiteSpace($TargetBranch) -and $TargetBranch -ne $branch) {
        Invoke-GitChecked -Arguments @("push", $selectedRemote, "$branch`:$TargetBranch")
    } else {
        Invoke-GitChecked -Arguments @("push", "--set-upstream", $selectedRemote, $branch)
    }

    Write-Host "Push:       complete"
} catch {
    Write-Host "[auto-push-github] ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
