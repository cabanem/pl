<#
.SYNOPSIS
    Merges file contents recursively from a source directory into a single output file.

.DESCRIPTION
    Replicates the functionality of a bash merge script.
    - recurses through directories
    - allows filtering by extension
    - prevents merging the output file into itself
    - adds clear headers between file contents

.EXAMPLE
    .\merge_files.ps1
    Merges all files in current dir to combined.txt

.EXAMPLE
    .\merge_files.ps1 -SourceDir "./src"
    Merges all files in ./src recursively to combined.txt

.EXAMPLE
    .\merge_files.ps1 -SourceDir "./src" -OutputFile "out.txt" -Extension "js"
    Merges only .js files in ./src recursively to out.txt
#>

param (
    [string]$SourceDir = ".",
    [string]$OutputFile = "combined.txt",
    [string]$Extension = ""
)

# -----------------------------------------------------------------------------
# 1. VALIDATION
# -----------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    Write-Error "Error: Directory '$SourceDir' does not exist."
    exit 1
}

# -----------------------------------------------------------------------------
# 2. PREPARE OUTPUT FILE
# -----------------------------------------------------------------------------
# Create (or overwrite) the output file immediately to establish the absolute path.
# -Force ensures we start with an empty file (simulating the '> file' bash redirection).
$OutFileItem = New-Item -Path $OutputFile -ItemType File -Force

# Get absolute path to prevent self-inclusion later
$AbsOutput = $OutFileItem.FullName

Write-Host "Reading recursively from: $SourceDir"
Write-Host "Writing to:               $AbsOutput"

# -----------------------------------------------------------------------------
# 3. BUILD FILE LIST
# -----------------------------------------------------------------------------
# Get-ChildItem is the PowerShell equivalent of 'find' or 'ls'
# -Recurse: traverses subdirectories
# -File: ignores directories in the results (only gets files)
# -Force: includes hidden files (to match 'find' behavior)

if ($Extension -ne "") {
    Write-Host "Mode: Only .$Extension files"
    $Files = Get-ChildItem -Path $SourceDir -Recurse -File -Force -Filter "*.$Extension"
}
else {
    Write-Host "Mode: All file types"
    $Files = Get-ChildItem -Path $SourceDir -Recurse -File -Force
}

# -----------------------------------------------------------------------------
# 4. EXECUTE LOOP
# -----------------------------------------------------------------------------
foreach ($File in $Files) {

    # Resolve absolute path strictly for comparison
    $AbsFile = $File.FullName

    # Skip if the file found is the output file itself
    if ($AbsFile -eq $AbsOutput) {
        continue
    }

    # Prepare the header string
    $Header = @"

################################################################################
### FILE: $($File.Name)
################################################################################

"@
    
    # Append Header to output
    # Encoding UTF8 is recommended for modern development environments
    Add-Content -LiteralPath $AbsOutput -Value $Header -Encoding UTF8

    # Append File Contents
    # -Raw reads the whole file as one string, preserving original line breaks
    try {
        Get-Content -LiteralPath $AbsFile -Raw | Add-Content -LiteralPath $AbsOutput -Encoding UTF8
        Write-Host "Processed: $AbsFile"
    }
    catch {
        Write-Warning "Could not read or write file: $AbsFile"
    }
}

Write-Host "------------------------------------------------"
Write-Host "Done! All content merged into $OutputFile"
