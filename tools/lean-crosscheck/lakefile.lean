import Lake
open Lake DSL

package crudcheck

lean_lib CrudCheck

@[default_target]
lean_exe crosscheck where
  root := `Main
