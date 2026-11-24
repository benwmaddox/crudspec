//go:build windows

package rt

import (
	"os"
	"syscall"
)

// lockFile opens p with no sharing, so no other process can open it while this one holds it;
// busy when another process has it open that way. (Its process id can't be read then.)
func lockFile(p string) (*os.File, bool, error) {
	name, err := syscall.UTF16PtrFromString(p)
	if err != nil {
		return nil, false, err
	}
	h, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		if err == syscall.Errno(32) { // ERROR_SHARING_VIOLATION
			return nil, true, nil
		}
		return nil, false, err
	}
	return os.NewFile(uintptr(h), p), false, nil
}

func unlockFile(f *os.File) { f.Close() }
