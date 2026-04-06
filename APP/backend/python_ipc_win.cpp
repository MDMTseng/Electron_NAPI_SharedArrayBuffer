// Windows stub: POSIX shared-memory Python IPC is not implemented on MSVC builds.
#include "python_ipc.h"
#include <iostream>

bool init_acceptor_ipc_bidirectional(
    const std::string& /*acceptor_executable*/,
    const std::string& /*acceptor_script_path*/,
    AcceptorDataCallback /*callback*/)
{
    std::cerr << "[IPC C++] Bi-directional Python IPC is not available on Windows (POSIX shm only).\n";
    return false;
}

void shutdown_acceptor_ipc_bidirectional() {}

bool send_data_to_acceptor_async(const uint8_t* /*input_data*/, size_t /*input_len*/)
{
    return false;
}
