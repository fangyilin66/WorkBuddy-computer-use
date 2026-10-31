# Self-test fixture: an isolated WinForms window the skill can read and drive
# without touching the user's own applications. It never closes anything but
# itself, and its title/pid make it an unambiguous target.
param([string]$OutDir = ".")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-JsonFile {
  param([string]$Name, [object]$Value)
  try {
    [IO.File]::WriteAllText((Join-Path $OutDir $Name), ($Value | ConvertTo-Json -Compress), $utf8)
  } catch {
    [IO.File]::WriteAllText((Join-Path $OutDir 'fixture-error.txt'), $_.Exception.Message, $utf8)
  }
}
$form = New-Object System.Windows.Forms.Form
$form.Text = 'WCU Self Test'
$form.Width = 560; $form.Height = 340
$form.StartPosition = 'CenterScreen'

$edit = New-Object System.Windows.Forms.TextBox
$edit.Name = 'fixture-edit'; $edit.AccessibleName = 'fixture-edit'
$edit.Text = 'native needle'; $edit.Left = 20; $edit.Top = 30; $edit.Width = 340
$edit.Add_TextChanged({ Write-JsonFile 'edit.json' @{ text = $edit.Text } })

$button = New-Object System.Windows.Forms.Button
$button.Name = 'fixture-button'
$button.Text = 'Fixture Button'; $button.Left = 20; $button.Top = 70; $button.Width = 140
$button.Add_Click({
  Write-JsonFile 'click.json' @{ clicks = 1; at = (Get-Date).ToString('o') }
})

$label = New-Object System.Windows.Forms.Label
$label.Name = 'fixture-label'
$label.Text = 'Ready needle'; $label.Left = 20; $label.Top = 120; $label.Width = 300

$form.Controls.Add($edit); $form.Controls.Add($button); $form.Controls.Add($label)
$form.Add_Shown({ [void]$edit.Focus() })
Write-JsonFile 'fixture.json' @{
  ready = $true
  handle = $form.Handle.ToInt64()
  title = $form.Text
  pid = $PID
}

[void]$form.ShowDialog()
