#include <iostream>
#include <cstdint>

void begin(int sda, int scl, uint32_t frequency=0) {
    std::cout << "Master begin: sda=" << sda << " scl=" << scl << "\n";
}
void begin(uint8_t addr, int sda, int scl, uint32_t frequency) {
    std::cout << "Slave begin\n";
}
void begin(int addr) {
    std::cout << "Single addr\n";
}

int main() {
    begin(27, 5);
    return 0;
}
