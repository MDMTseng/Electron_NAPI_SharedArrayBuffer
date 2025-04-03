cmake_minimum_required(VERSION 3.10)
project(ElectronPlugins)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Set output directories
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)

# Add shared library for the sample plugin
add_library(sample_plugin SHARED
    sample_plugin.cc
)

# Set the output name based on the platform
if(WIN32)
    set_target_properties(sample_plugin PROPERTIES SUFFIX ".dll")
elseif(APPLE)
    set_target_properties(sample_plugin PROPERTIES SUFFIX ".dylib")
else()
    set_target_properties(sample_plugin PROPERTIES SUFFIX ".so")
endif()

# Include directories
target_include_directories(sample_plugin PRIVATE ${CMAKE_SOURCE_DIR}/..) 