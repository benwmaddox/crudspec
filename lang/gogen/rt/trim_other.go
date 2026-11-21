//go:build !linux

package rt

// trimCHeap: only glibc (Linux) needs asking to hand freed C memory back (trim_linux.go)
func trimCHeap() {}
