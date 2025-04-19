cmake_minimum_required(VERSION 3.10)
project(ElectronPlugins)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find OpenCV package
find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs)

# === Add BPG Protocol Library ===
add_subdirectory(BPG_Protocol)
# ==============================

# Set output directories
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)

# Add shared library for the sample plugin
add_library(sample_plugin SHARED
    sample_plugin.cc
    python_ipc.cc
)

# Link dependencies for sample plugin
target_link_libraries(sample_plugin PRIVATE 
    ${OpenCV_LIBS}
    bpg_protocol
    # On Linux, might need -lrt for POSIX shared memory/semaphores
    # if(UNIX AND NOT APPLE)
    #   target_link_libraries(sample_plugin PRIVATE rt)
    # endif()
)
target_include_directories(sample_plugin PRIVATE 
    ${CMAKE_CURRENT_SOURCE_DIR}/include # For plugin_interface.h
    ${CMAKE_CURRENT_SOURCE_DIR}/BPG_Protocol # For BPG headers
    ${OpenCV_INCLUDE_DIRS}
)

# Set the output name based on the platform
if(WIN32)
    set_target_properties(sample_plugin PROPERTIES SUFFIX ".dll")
elseif(APPLE)
    set_target_properties(sample_plugin PROPERTIES SUFFIX ".dylib")
else()
    set_target_properties(sample_plugin PROPERTIES SUFFIX ".so")
endif()