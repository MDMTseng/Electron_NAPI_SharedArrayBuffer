cmake_minimum_required(VERSION 3.10)
project(ElectronPlugins)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find OpenCV package
find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs)

# Add pybind11
add_subdirectory(pybind11)
find_package(Python COMPONENTS Interpreter Development REQUIRED)

# === Add BPG Protocol Library ===
add_subdirectory(BPG_Protocol)
# ==============================

# Set output directories
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)

# Add Python plugin first (since sample_plugin depends on it)
add_library(python_plugin SHARED
    python_plugin.cc
)

# Add shared library for the sample plugin
add_library(sample_plugin SHARED
    sample_plugin.cc
)

# Link dependencies for Python plugin
target_link_libraries(python_plugin PRIVATE 
    pybind11::embed
    Python::Python
)
target_include_directories(python_plugin PRIVATE 
    ${CMAKE_SOURCE_DIR}/..
    ${Python_INCLUDE_DIRS}
)

# Link dependencies for sample plugin
target_link_libraries(sample_plugin PRIVATE 
    ${OpenCV_LIBS}
    bpg_protocol
    python_plugin
    pybind11::embed
    Python::Python
)
target_include_directories(sample_plugin PRIVATE 
    ${CMAKE_SOURCE_DIR}/..
    ${Python_INCLUDE_DIRS}
)

# Set the output name based on the platform
if(WIN32)
    set_target_properties(sample_plugin python_plugin PROPERTIES SUFFIX ".dll")
elseif(APPLE)
    set_target_properties(sample_plugin python_plugin PROPERTIES SUFFIX ".dylib")
else()
    set_target_properties(sample_plugin python_plugin PROPERTIES SUFFIX ".so")
endif()