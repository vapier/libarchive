import { Process, SyscallEntry, SyscallHandler, WASI } from "./wjb.js";

const ARCHIVE_EOF = 1;
const ARCHIVE_OK = 0;
const ARCHIVE_RETRY = (-10);
const ARCHIVE_WARN = (-20);
const ARCHIVE_FAILED = (-25);
const ARCHIVE_FATAL = (-30);

const FD_STDIN = 0;
const FD_STDOUT = 1;
const FD_STDERR = 2;
const FD_CWD = 3;
const FD_ROM = 4;

function log(...args) {
  console.log(...args);
  const td = new TextDecoder();
  const e = document.getElementById("log");
  e.textContent += args.map((x) => x.toString()).join(' ') + '\n';
}

/**
 * Syscall handler that glues the JS/DOM world to the WASM world.
 * This isn't meant to be complete or perfect, simply enough to make WGU work.
 */
class WguSyscallHandler extends SyscallHandler.DirectWasiPreview1 {
  constructor(...args) {
    super(...args);
    this.log = document.getElementById("log");
    this.td = new TextDecoder();
    this.inputOffset = 0;
    this.outputOffset = 0;
  }

  // Write data to a file descriptor.
  handle_fd_write(fd, buf) {
    switch (fd) {
      case FD_STDOUT:
      case FD_STDERR:
        this.log.value += this.td.decode(buf, { stream: true });
        return { nwritten: buf.length };

      case FD_ROM: {
        romBuffer.set(buf, this.outputOffset);
        this.outputOffset += buf.length;
        return { nwritten: buf.length };
      }
    }

    return WASI.errno.EBADF;
  }

  // Write data to a file descriptor with specific offset.
  handle_fd_pwrite(fd, buf, offset) {
    switch (fd) {
      case FD_ROM: {
        romBuffer.set(buf, Number(offset));
        return { nwritten: buf.length };
      }
    }
    return WASI.errno.EBADF;
  }

  // Ignore unlink requests since we always create anew.
  handle_path_unlink_file(fd, path) {
    return WASI.errno.ESUCCESS;
  }

  // File descriptors opened before the program runs.
  // Really just fake the current working directory.
  handle_fd_prestat_get(fd) {
    switch (fd) {
      case FD_CWD:
        return { path: "." };
      default:
        return WASI.errno.EBADF;
    }
  }

  // Names for the file descriptors opened before the program runs.
  handle_fd_prestat_dir_name(fd) {
    switch (fd) {
      case FD_CWD:
        return { path: "." };
      default:
        return WASI.errno.EBADF;
    }
  }

  // The file descriptor stat details (mostly WASI perms).
  handle_fd_fdstat_get(fd) {
    const ret = {
      fs_filetype: WASI.filetype.UNKNOWN,
      fs_flags: 0,
      fs_rights_base: 0xffffffffffffffffn,
      fs_rights_inheriting: 0xffffffffffffffffn,
    };
    switch (fd) {
      case FD_CWD:
        return {
          ...ret,
          fs_filetype: WASI.filetype.DIRECTORY,
        };
      case FD_ROM:
        return {
          ...ret,
          fs_filetype: WASI.filetype.REGULAR_FILE,
        };
    }
    return WASI.errno.EBADF;
  }

  // The file descriptor stat details (standard UNIX stuff).
  handle_fd_filestat_get(fd) {
    const ret = {
      dev: 0n,
      ino: 0n,
      filetype: WASI.filetype.UNKNOWN,
      nlink: 0n,
      size: 0n,
      atim: 0n,
      mtim: 0n,
      ctim: 0n,
    };
    switch (fd) {
      case FD_ROM:
        return {
          ...ret,
          filetype: WASI.filetype.REGULAR_FILE,
          size: BigInt(romBuffer.length),
        };
    }
    return WASI.errno.EBADF;
  }

  // Request to open files.
  handle_path_open(
    dirfd,
    dirflags,
    path,
    o_flags,
    fs_rights_base,
    fs_rights_inheriting,
    fdflags,
  ) {
    if (dirfd === FD_CWD) {
      switch (path) {
        case inputRom.name: {
          return { fd: FD_ROM };
        }
      }
    }
    return WASI.errno.ENOENT;
  }

  // Read data from a file descriptor.
  handle_fd_read(fd, length) {
    switch (fd) {
      case FD_ROM: {
        const slice = romBuffer.slice(
          this.inputOffset,
          this.inputOffset + length,
        );
        this.inputOffset += slice.length;
        return {
          nread: slice.length,
          buf: slice,
        };
      }
    }
    return WASI.errno.EBADF;
  }

  // Read data from a file descriptor with specific offset.
  handle_fd_pread(fd, length, offset) {
    switch (fd) {
      case FD_ROM: {
        offset = Number(offset);
        const slice = romBuffer.slice(offset, offset + length);
        return {
          nread: slice.length,
          buf: slice,
        };
      }
    }
    return WASI.errno.EBADF;
  }

  // Close a file descriptor.
  handle_fd_close(fd) {
    return WASI.errno.ESUCCESS;
  }
}

/**
 * Helper to run the WASI program using the WJB framework.
 */
async function run(prog, argv, debug = false) {
  const handler = new WguSyscallHandler();
  const sys_handlers = [handler];
  const proc = new Process.Foreground({
    executable: prog,
    argv: ["libarchive.wasm", ...argv],
    debug: debug,
    sys_handlers: sys_handlers,
    sys_entries: [
      new SyscallEntry.WasiPreview1({ sys_handlers, debug, trace: debug }),
    ],
  });
  WGU.process = proc;
  return await proc.run();
}

function sleep(msec) {
  return new Promise((resolve) => setTimeout(resolve, msec));
}

/**
 * Callback to initialize the page when it finishes loading.
 */
async function DOMContentLoaded() {
  globalThis.WGU = {};

  // Fetch & read the program.
  WGU.wasm = await fetch("libarchive.wasm").then((response) =>
    response.arrayBuffer(),
  );

  const debug = true;
  const ret = await run(
    WGU.wasm,
    [],
    debug,
  );
  log('Loading wasm:', ret === 0, ret);

  WGU.lib = WGU.process.instance_.exports;

  // Read out the library version.
  const vptr = WGU.lib.archive_version_string();
  const vmem = WGU.process.getMem(vptr);
  const nul = vmem.indexOf(0);
  const vbytes = vmem.slice(0, nul);
  const td = new TextDecoder();
  const version = td.decode(vbytes);
  document.getElementById("version").textContent = version;

  // Connect the UI.
  const selector = document.getElementById("selector");
  selector.addEventListener("change", processLocalFile);

  const downloader = document.getElementById("download");
  downloader.addEventListener("click", processRemoteFile);

  const url = document.getElementById("url");
  url.addEventListener("keypress", triggerRemote);
}

function triggerRemote(e) {
  if (e.key === 'Enter') {
    processRemoteFile();
  }
}

/**
 * Callback when the user selects a local file.
 */
async function processLocalFile() {
  const selector = document.getElementById("selector");
  const file = selector.files[0];
  document.getElementById("log").replaceChildren();
  log(`Loading ${file.name} ...`);
  const data = await file.bytes();
  processFile(data);
}

/**
 * Callback when the user selects a remote file.
 */
async function processRemoteFile() {
  const url = document.getElementById("url");
  document.getElementById("log").replaceChildren();
  log(`Loading '${url.value}' ...`);
  let data;
  try {
    data = await fetch(url.value)
      .then((response) => response.blob())
      .then((blob) => blob.bytes());
  } catch (e) {
   log('Download failed (see JS console)', e);
   return;
  }
  processFile(data);
}

/**
 * Load file from bytes.
 */
async function processFile(data) {
  WGU.data = data;

  const filesEle = document.getElementById("files");
  filesEle.replaceChildren();

  const datasize = 1024 * 1024;
  const dataptr = WGU.lib.malloc(datasize);
  log('dataptr', dataptr);

  const dptr = WGU.lib.malloc(WGU.data.byteLength);
  log('malloc', dptr !== 0, dptr);
  let dmem = WGU.process.getMem(dptr, dptr + WGU.data.byteLength);
  dmem.set(WGU.data);

  const a = WGU.lib.archive_read_new();
  log('new', a !== 0, a);
  let ret;
  ret = WGU.lib.archive_read_support_filter_all(a);
  ret = WGU.lib.archive_read_support_format_all(a);
  ret = WGU.lib.archive_read_open_memory(a, dptr, WGU.data.byteLength);
  log('read_open_memory', ret === ARCHIVE_OK, ret);

  const td = new TextDecoder();
  const ae = WGU.lib.archive_entry_new();
  log('new_entry', ae !== 0, ae);
  let cnt = 0;
  while (1) {
    log('file count', ++cnt);
    ret = WGU.lib.archive_read_next_header2(a, ae);
    if (cnt % 10 === 0)
      await sleep(0);
    log('read_next_header', ret);
    if (ret !== ARCHIVE_OK)
      break;
    const pptr = WGU.lib.archive_entry_pathname(ae);
    log('entry_pathname', pptr);
    const size = WGU.lib.archive_entry_size(ae);
    log('entry_size', size);
    if (pptr) {
      dmem = WGU.process.getMem(pptr);
      const nul = dmem.indexOf(0);
      const pbytes = dmem.slice(0, nul);
      const pathname = td.decode(pbytes);
      log(pathname);

      const newEle = document.createElement('li');
      const openEle = document.createElement('a');
      openEle.className = 'open';
      openEle.target = '_blank';
      openEle.title = 'Open file in new tab';
      newEle.appendChild(openEle);
      const dlEle = document.createElement('a');
      dlEle.className = 'download';
      dlEle.title = 'Download file';
      dlEle.download = pathname;
      newEle.appendChild(dlEle);
      const sizeEle = document.createElement('span');
      sizeEle.className = 'size';
      sizeEle.textContent = size;
      newEle.appendChild(sizeEle);
      const labelEle = document.createElement('span');
      labelEle.textContent = pathname;
      newEle.appendChild(labelEle);
      filesEle.appendChild(newEle);

      const chunks = [];
      while (1) {
        ret = WGU.lib.archive_read_data(a, dataptr, datasize);
        if (ret <= 0) {
          break;
        }
        dmem = WGU.process.getMem(dataptr, dataptr + ret);
        chunks.push(dmem.slice(0));
        // log(td.decode(dmem));
      }
      const txtBlob = new Blob(chunks, {type: 'text/plain'});
      openEle.href = URL.createObjectURL(txtBlob);
      const binBlob = new Blob(chunks, {type: 'application/octet-stream'});
      dlEle.href = URL.createObjectURL(binBlob);
    }
  }
  if (ret !== ARCHIVE_EOF)
    log('read_next_header failed', ret);

  ret = WGU.lib.archive_read_free(a);
  log('read_free', ret === ARCHIVE_OK, ret);
  ret = WGU.lib.free(dptr);
}

globalThis.addEventListener("DOMContentLoaded", DOMContentLoaded);
