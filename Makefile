CC     := gcc
CFLAGS := -Wall -Wextra -g -std=gnu11
TARGET := flameoshell
SRC    := flameoshell.c

.PHONY: all run clean

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) $(SRC) -o $(TARGET)

run: $(TARGET)
	./$(TARGET)

clean:
	rm -f $(TARGET) *.o