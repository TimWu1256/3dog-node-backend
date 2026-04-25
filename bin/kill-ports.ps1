@(2024, 3000, 3601, 3681) | ForEach-Object {
    $port = $_
    $pids = (netstat -ano | Select-String ":$port ") | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique
    foreach ($p in $pids) {
        if ($p -match '^\d+$' -and $p -ne '0') {
            $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
            Write-Host "Port $port -> PID $p ($($proc.Name)) - killing"
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        }
    }
}

@(2024, 3000, 3601, 3681) | ForEach-Object {
    $port = $_
    $result = netstat -ano | Select-String ":$port "
    if ($result) { Write-Host "Port $port still in use" } else { Write-Host "Port $port is free" }
}
